'use strict';
// Task Manager backend (renderer/apps/taskmgr). Everything per tick is read straight from /proc
// and /sys: no process is spawned while polling. systemctl / loginctl are only run for the
// Services and Users pages (a few seconds apart).
//
//   proc:list                     -> [{pid, ppid, name, comm, cmdline, exe, user, uid, state, threads, cpu, mem, priv,
//                                      disk, cpuTime, startTime, nice, kernel, tty}]
//                                    cpu   % of the whole machine (all cores = 100) since the previous call
//                                    mem   resident set size (RSS, bytes); priv = private/anonymous resident bytes
//                                    disk  storage bytes/s (read + write) since the previous call (own processes)
//                                    cpuTime seconds of CPU used since the process started; startTime epoch ms
//   proc:shell                    -> {mainPid, processes:[{pid, type, name, service}], webContents:[{id, pid, type}]}
//   proc:info (pid)               -> details for the Properties dialog (exe, cwd, cmdline, parent, unit, fds, peak memory…)
//   proc:alive (pids)             -> {pid: boolean}  (zombies count as gone)
//   proc:kill (pid, signal)       -> true   signal: SIGTERM (default) SIGKILL SIGSTOP SIGCONT SIGINT SIGHUP…
//                                    errors: EPERM (someone else's process: use shell.runAdmin('kill-process', …)),
//                                            ESRCH (already gone), EINVAL (pid 1, kernel threads, bad signal)
//   proc:killTree (pid, signal)   -> {killed:[pid…], failed:[{pid, code}]}  children first; the shell's own
//                                    processes (its main process and everything under it) are left alone
//                                    unless the tree being ended is the shell's
//   proc:setPriority (pid, nice)  -> nice (applied to every thread). EACCES when lowering niceness needs admin,
//                                    EPERM for another user's process
//   proc:spawn (commandLine)      -> {pid}  runs the command detached with the user's privileges (ENOENT if not
//                                    found, EACCES if the file isn't a program / can't be executed)
//   perf:snapshot                 -> {time, cpu, mem, disks, net, gpu}   (see snapshot() below)
//   perf:services                 -> {mock, services:[{unit, name, description, load, active, sub, startup, pid}]}
//   perf:users                    -> [{user, uid, fullName, status, sessions:[{id, state, type, tty, seat, remote, since}]}]
//   perf:startup                  -> {bootTime, entries:[{id, name, comment, exec, icon, enabled, scope}]}  (XDG autostart)
//   perf:startupSet (id, enabled) -> true   (writes an override in ~/.config/autostart)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { run, which } = require('../lib/exec');

const PF_KTHREAD = 0x00200000;
let CLK_TCK = 100; // USER_HZ: 100 on every architecture Aurora ships; confirmed with getconf below
let PAGE = 4096;

function rd(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
function rl(file) {
  try {
    return fs.readlinkSync(file);
  } catch {
    return null;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ users (/etc/passwd)
let pw = { mtime: -1, byUid: new Map() };
function passwd() {
  let mtime = 0;
  try {
    mtime = fs.statSync('/etc/passwd').mtimeMs;
  } catch {}
  if (mtime !== pw.mtime) {
    const byUid = new Map();
    for (const line of (rd('/etc/passwd') || '').split('\n')) {
      const p = line.split(':');
      if (p.length < 7) continue;
      byUid.set(Number(p[2]), { name: p[0], fullName: (p[4] || '').split(',')[0] || p[0], home: p[5], shell: p[6] });
    }
    pw = { mtime, byUid };
  }
  return pw.byUid;
}
const userName = (uid) => passwd().get(uid)?.name ?? String(uid);

// ------------------------------------------------------------------ /proc helpers
function bootTimeMs() {
  const m = /^btime\s+(\d+)/m.exec(rd('/proc/stat') || '');
  return m ? Number(m[1]) * 1000 : Date.now() - os.uptime() * 1000;
}
let BOOT = bootTimeMs();

function cpuLines() {
  const out = [];
  for (const line of (rd('/proc/stat') || '').split('\n')) {
    if (!line.startsWith('cpu')) {
      if (out.length) break;
      continue;
    }
    const v = line.trim().split(/\s+/);
    const n = v.slice(1, 9).map(Number); // user nice system idle iowait irq softirq steal (guest is inside user)
    const idle = n[3] + (n[4] || 0);
    let total = 0;
    for (const x of n) total += x || 0;
    out.push({ id: v[0], idle, total });
  }
  return out;
}

function parseStat(text) {
  const lp = text.indexOf('(');
  const rp = text.lastIndexOf(')');
  if (lp < 0 || rp < 0) return null;
  const f = text.slice(rp + 2).split(' ');
  return {
    comm: text.slice(lp + 1, rp),
    state: f[0],
    ppid: Number(f[1]),
    tty: Number(f[4]),
    flags: Number(f[6]),
    utime: Number(f[11]),
    stime: Number(f[12]),
    nice: Number(f[16]),
    threads: Number(f[17]),
    start: Number(f[19]),
    rss: Number(f[21]),
  };
}

function procName(comm, argv0) {
  // comm is truncated to 15 characters by the kernel: prefer the executable's name when it extends it.
  if (argv0 && comm.length >= 15) {
    const base = argv0.split('/').pop().split(' ')[0];
    if (base && base.length > comm.length && base.startsWith(comm)) return base;
  }
  return comm;
}

const meta = new Map(); // `${pid}:${start}` -> { cmdline, argv0, uid, name, comm, exe, io, seen }
function metaFor(pid, st) {
  const key = `${pid}:${st.start}`;
  let m = meta.get(key);
  if (!m || m.comm !== st.comm) {
    const raw = rd(`/proc/${pid}/cmdline`) || '';
    const parts = raw.split('\0').filter((x, i, a) => x || i < a.length - 1);
    let uid = -1;
    try {
      uid = fs.statSync(`/proc/${pid}`).uid;
    } catch {}
    m = {
      cmdline: parts.join(' ').trim(),
      argv0: parts[0] || '',
      uid,
      comm: st.comm,
      name: procName(st.comm, parts[0] || ''),
      exe: undefined,
      io: m?.io ?? null,
    };
    meta.set(key, m);
  }
  m.seen = true;
  return { key, m };
}

function readIo(pid) {
  const txt = rd(`/proc/${pid}/io`);
  if (txt == null) return null;
  const r = /read_bytes:\s+(\d+)/.exec(txt);
  const w = /write_bytes:\s+(\d+)/.exec(txt);
  return (r ? Number(r[1]) : 0) + (w ? Number(w[1]) : 0);
}

function listPids() {
  let names = [];
  try {
    names = fs.readdirSync('/proc');
  } catch {}
  const out = [];
  for (const n of names) {
    const c = n.charCodeAt(0);
    if (c >= 48 && c <= 57) out.push(Number(n));
  }
  return out;
}

// One raw sample of every process: { at, total, rows: Map(pid -> {...}) }
function sampleProcs({ io = true } = {}) {
  const at = Date.now();
  const total = cpuLines()[0]?.total || 0;
  const rows = new Map();
  for (const m of meta.values()) m.seen = false;
  for (const pid of listPids()) {
    const text = rd(`/proc/${pid}/stat`);
    if (!text) continue;
    const st = parseStat(text);
    if (!st) continue;
    const kernel = (st.flags & PF_KTHREAD) !== 0 || pid === 2 || st.ppid === 2;
    const { key, m } = metaFor(pid, st);
    let priv = 0;
    if (!kernel) {
      const sm = rd(`/proc/${pid}/statm`);
      if (sm) {
        const v = sm.split(' ');
        priv = Math.max(0, Number(v[1]) - Number(v[2])) * PAGE;
      }
    }
    let ioBytes = null;
    if (io && !kernel && m.io !== false) {
      ioBytes = readIo(pid);
      if (ioBytes == null) m.io = false;
    }
    rows.set(pid, { key, st, m, kernel, priv, ioBytes });
  }
  for (const [k, m] of meta) if (!m.seen) meta.delete(k);
  return { at, total, rows };
}

const procState = { prev: null, cache: null, cacheAt: 0, inflight: null };

async function procList() {
  if (procState.cache && Date.now() - procState.cacheAt < 300) return procState.cache;
  if (procState.inflight) return procState.inflight;
  procState.inflight = (async () => {
    if (!procState.prev) {
      procState.prev = sampleProcs();
      await sleep(150);
    }
    const prev = procState.prev;
    const cur = sampleProcs();
    const dTotal = Math.max(1, cur.total - prev.total);
    const dt = Math.max(0.001, (cur.at - prev.at) / 1000);
    const users = passwd();
    const out = [];
    for (const [pid, r] of cur.rows) {
      const { st, m } = r;
      const p = prev.rows.get(pid);
      const same = p && p.key === r.key;
      const t = st.utime + st.stime;
      const cpu = same ? Math.max(0, Math.min(100, ((t - (p.st.utime + p.st.stime)) / dTotal) * 100)) : 0;
      const disk = same && r.ioBytes != null && p.ioBytes != null ? Math.max(0, (r.ioBytes - p.ioBytes) / dt) : 0;
      out.push({
        pid,
        ppid: st.ppid,
        name: m.name,
        comm: st.comm,
        cmdline: m.cmdline,
        user: users.get(m.uid)?.name ?? (m.uid >= 0 ? String(m.uid) : ''),
        uid: m.uid,
        state: st.state,
        threads: st.threads,
        cpu,
        mem: st.rss * PAGE,
        priv: r.priv,
        disk,
        cpuTime: t / CLK_TCK,
        startTime: Math.round(BOOT + (st.start / CLK_TCK) * 1000),
        nice: st.nice,
        kernel: r.kernel,
        tty: st.tty,
      });
    }
    procState.prev = cur;
    procState.cache = out;
    procState.cacheAt = Date.now();
    return out;
  })();
  try {
    return await procState.inflight;
  } finally {
    procState.inflight = null;
  }
}

function shellProcesses() {
  const { app, webContents } = require('electron');
  const processes = [];
  try {
    for (const m of app.getAppMetrics()) processes.push({ pid: m.pid, type: m.type, name: m.name || '', service: m.serviceName || '' });
  } catch {}
  const wcs = [];
  try {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      let pid = 0;
      try {
        pid = wc.getOSProcessId();
      } catch {}
      wcs.push({ id: wc.id, pid, type: wc.getType() });
    }
  } catch {}
  return { mainPid: process.pid, processes, webContents: wcs };
}

// systemd unit of a process from its cgroup (v2 "0::/system.slice/ssh.service", v1 "1:name=systemd:/…").
// The innermost service wins: user services live under user@1000.service/app.slice/x.service.
function unitOfPid(pid) {
  const txt = rd(`/proc/${pid}/cgroup`) || '';
  for (const line of txt.split('\n')) {
    const p = line.split(':');
    if (p.length < 3 || !(p[0] === '0' || p[1] === 'name=systemd')) continue;
    const cg = p.slice(2).join(':');
    const svc = [...cg.matchAll(/\/([^/]+\.service)(?=\/|$)/g)].map((x) => x[1]);
    if (svc.length) return svc[svc.length - 1];
    const scope = /\/([^/]+\.scope)(?:\/|$)/.exec(cg);
    return scope ? scope[1] : null;
  }
  return null;
}

function procInfo(pid) {
  pid = Number(pid);
  const text = rd(`/proc/${pid}/stat`);
  if (!text) throw Object.assign(new Error('The process no longer exists'), { code: 'ESRCH' });
  const st = parseStat(text);
  const status = {};
  for (const line of (rd(`/proc/${pid}/status`) || '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) status[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const kb = (k) => (status[k] ? Number(status[k].split(/\s+/)[0]) * 1024 : null);
  const raw = rd(`/proc/${pid}/cmdline`) || '';
  const parent = st.ppid ? parseStat(rd(`/proc/${st.ppid}/stat`) || '') : null;
  let fds = null;
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`).length;
  } catch {}
  let uid = -1;
  try {
    uid = fs.statSync(`/proc/${pid}`).uid;
  } catch {}
  const exe = (rl(`/proc/${pid}/exe`) || '').replace(/ \(deleted\)$/, '');
  return {
    pid,
    ppid: st.ppid,
    parentName: parent?.comm || '',
    name: procName(st.comm, raw.split('\0')[0] || ''),
    comm: st.comm,
    exe,
    cwd: rl(`/proc/${pid}/cwd`) || '',
    cmdline: raw.split('\0').join(' ').trim(),
    uid,
    user: userName(uid),
    state: st.state,
    threads: st.threads,
    nice: st.nice,
    kernel: (st.flags & PF_KTHREAD) !== 0 || pid === 2 || st.ppid === 2,
    startTime: Math.round(BOOT + (st.start / CLK_TCK) * 1000),
    cpuTime: (st.utime + st.stime) / CLK_TCK,
    mem: st.rss * PAGE,
    peak: kb('VmHWM'),
    virt: kb('VmSize'),
    swap: kb('VmSwap'),
    ctxSwitches: Number(status.voluntary_ctxt_switches || 0) + Number(status.nonvoluntary_ctxt_switches || 0),
    fds,
    unit: unitOfPid(pid),
  };
}

// ------------------------------------------------------------------ actions on processes
const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGSTOP', 'SIGCONT', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2']);

function errCode(err) {
  return err?.info?.code || err?.code || 'EFAIL';
}

function checkTarget(api, pid) {
  if (!Number.isInteger(pid) || pid <= 1) throw api.error('This process cannot be ended', 'EINVAL');
  const text = rd(`/proc/${pid}/stat`);
  if (!text) throw api.error('The process no longer exists', 'ESRCH');
  const st = parseStat(text);
  if (st && ((st.flags & PF_KTHREAD) !== 0 || pid === 2 || st.ppid === 2)) throw api.error('Kernel threads cannot be ended', 'EINVAL');
  return st;
}

function killOne(api, pid, signal) {
  checkTarget(api, pid);
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    const code = errCode(err);
    if (code === 'EPERM') throw api.error('Access is denied', 'EPERM');
    if (code === 'ESRCH') throw api.error('The process no longer exists', 'ESRCH');
    throw api.error(err.message, code);
  }
}

// Every descendant of pid, deepest first. The subtree rooted at `keep` (the shell's main process:
// its GPU, renderer and utility processes) is left out unless it is the tree being ended.
function descendants(pid, keep = null) {
  const children = new Map();
  for (const p of listPids()) {
    const st = parseStat(rd(`/proc/${p}/stat`) || '');
    if (!st) continue;
    if (!children.has(st.ppid)) children.set(st.ppid, []);
    children.get(st.ppid).push(p);
  }
  const order = [];
  const walk = (p, depth) => {
    if (depth > 64) return;
    for (const c of children.get(p) || []) {
      if (c === keep && c !== pid) continue;
      walk(c, depth + 1);
      order.push(c);
    }
  };
  walk(pid, 0);
  return order; // deepest first
}

function setPriority(api, pid, nice) {
  pid = Number(pid);
  nice = Math.max(-20, Math.min(19, Math.round(Number(nice))));
  checkTarget(api, pid);
  let tids = [];
  try {
    tids = fs.readdirSync(`/proc/${pid}/task`).map(Number);
  } catch {
    tids = [pid];
  }
  let done = 0;
  let firstErr = null;
  for (const tid of tids) {
    try {
      os.setPriority(tid, nice);
      done++;
    } catch (err) {
      const code = errCode(err);
      if (code === 'ESRCH') continue;
      firstErr = firstErr || code;
    }
  }
  if (!done && firstErr) {
    if (firstErr === 'EACCES') throw api.error('Raising the priority needs administrator rights', 'EACCES');
    if (firstErr === 'EPERM') throw api.error('Access is denied', 'EPERM');
    throw api.error(`Could not change the priority (${firstErr})`, firstErr);
  }
  return nice;
}

function splitCommand(s) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]);
  return out;
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function spawnCommand(api, line) {
  const cmd = String(line || '').trim();
  if (!cmd) throw api.error('Nothing to run', 'EINVAL');
  const shellish = /[|&;<>()$`*?[\]{}\n]/.test(cmd);
  const argv = splitCommand(cmd).map(expandHome);
  if (!argv.length) throw api.error('Nothing to run', 'EINVAL');
  if (!shellish && !which(argv[0])) {
    throw api.error(`'${argv[0]}' was not found`, 'ENOENT');
  }
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('ELECTRON_') || k === 'NODE_OPTIONS' || k === 'CHROME_DESKTOP') delete env[k];
  const child = shellish
    ? spawn('/bin/sh', ['-c', cmd], { cwd: os.homedir(), env, detached: true, stdio: 'ignore' })
    : spawn(which(argv[0]), argv.slice(1), { argv0: argv[0], cwd: os.homedir(), env, detached: true, stdio: 'ignore' });
  const res = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ pid: child.pid }), 400);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(api.error(err.message, err.code === 'ENOENT' || err.code === 'EACCES' ? err.code : 'EFAIL'));
    });
    child.once('exit', (code) => {
      if (code === 127 || code === 126) {
        clearTimeout(timer);
        reject(api.error(`'${argv[0]}' was not found`, 'ENOENT'));
      }
    });
  });
  child.unref();
  return res;
}

// ------------------------------------------------------------------ performance
let cpuStatic = null;
function cpuInfoStatic() {
  if (cpuStatic) return cpuStatic;
  const txt = rd('/proc/cpuinfo') || '';
  const blocks = txt.split(/\n\s*\n/).filter((b) => b.trim());
  const cores = new Set();
  const sockets = new Set();
  let model = '';
  let flags = '';
  let mhz = 0;
  for (const b of blocks) {
    const get = (k) => new RegExp(`^${k}\\s*:\\s*(.*)$`, 'mi').exec(b)?.[1]?.trim();
    model = model || get('model name') || get('Model') || get('cpu model') || get('Hardware') || '';
    flags = flags || get('flags') || get('Features') || '';
    mhz = mhz || Number(get('cpu MHz')) || 0;
    const phys = get('physical id') ?? '0';
    const core = get('core id');
    sockets.add(phys);
    if (core != null) cores.add(`${phys}:${core}`);
  }
  const logical = os.cpus().length || blocks.length || 1;
  const sysCpu = '/sys/devices/system/cpu/cpu0';
  const khz = (f) => Number(rd(`${sysCpu}/cpufreq/${f}`)) || 0;
  let baseMHz = khz('base_frequency') / 1000 || 0;
  const maxMHz = khz('cpuinfo_max_freq') / 1000 || 0;
  if (!baseMHz) {
    const m = /@\s*([\d.]+)\s*GHz/i.exec(model);
    baseMHz = m ? Number(m[1]) * 1000 : maxMHz || mhz || os.cpus()[0]?.speed || 0;
  }
  const caches = {};
  for (let i = 0; i < 8; i++) {
    const dir = `${sysCpu}/cache/index${i}`;
    const level = rd(`${dir}/level`);
    if (level == null) break;
    const type = (rd(`${dir}/type`) || '').trim();
    const size = parseCacheSize(rd(`${dir}/size`));
    if (!size) continue;
    // Total per level across the package: count the distinct shared_cpu_list groups.
    const per = cacheInstances(i);
    const key = `l${level.trim()}`;
    if (type === 'Instruction' || type === 'Data' || type === 'Unified') caches[key] = (caches[key] || 0) + size * per;
  }
  const hypervisor = /\bhypervisor\b/.test(flags);
  cpuStatic = {
    model: model.replace(/\s+/g, ' ').trim() || os.cpus()[0]?.model || 'CPU',
    logical,
    cores: cores.size || logical,
    sockets: sockets.size || 1,
    baseMHz: Math.round(baseMHz),
    maxMHz: Math.round(maxMHz),
    virtualization: /\b(vmx|svm)\b/.test(flags) ? 'enabled' : hypervisor ? 'unavailable' : 'disabled',
    vm: hypervisor,
    caches,
  };
  return cpuStatic;
}
function parseCacheSize(s) {
  const m = /(\d+)\s*([KMG]?)/i.exec(s || '');
  if (!m) return 0;
  return Number(m[1]) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2].toUpperCase()] || 1);
}
function cacheInstances(index) {
  const groups = new Set();
  const n = os.cpus().length || 1;
  for (let c = 0; c < n; c++) {
    const l = rd(`/sys/devices/system/cpu/cpu${c}/cache/index${index}/shared_cpu_list`);
    if (l) groups.add(l.trim());
  }
  return groups.size || 1;
}

let mhzCache = { at: 0, value: 0 };
function currentMHz() {
  const n = os.cpus().length || 1;
  let sum = 0;
  let cnt = 0;
  for (let c = 0; c < n; c++) {
    const v = Number(rd(`/sys/devices/system/cpu/cpu${c}/cpufreq/scaling_cur_freq`));
    if (v) {
      sum += v / 1000;
      cnt++;
    }
  }
  if (cnt) return Math.round(sum / cnt);
  if (Date.now() - mhzCache.at > 5000) {
    const vals = [...(rd('/proc/cpuinfo') || '').matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map((m) => Number(m[1]));
    mhzCache = { at: Date.now(), value: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : cpuInfoStatic().baseMHz };
  }
  return mhzCache.value;
}

function meminfo() {
  const m = {};
  for (const line of (rd('/proc/meminfo') || '').split('\n')) {
    const r = /^([\w()]+):\s+(\d+)/.exec(line);
    if (r) m[r[1]] = Number(r[2]) * 1024;
  }
  const total = m.MemTotal || os.totalmem();
  const available = m.MemAvailable ?? os.freemem();
  const free = m.MemFree ?? os.freemem();
  const cached = (m.Cached || 0) + (m.Buffers || 0) + (m.SReclaimable || 0) - (m.Shmem || 0);
  const modified = (m.Dirty || 0) + (m.Writeback || 0);
  const used = Math.max(0, total - available);
  return {
    total,
    used,
    available,
    free,
    cached: Math.max(0, cached),
    buffers: m.Buffers || 0,
    modified,
    standby: Math.max(0, total - used - free - modified),
    shared: m.Shmem || 0,
    slab: m.Slab || 0,
    slabReclaimable: m.SReclaimable || 0,
    kernelStack: m.KernelStack || 0,
    pageTables: m.PageTables || 0,
    committed: m.Committed_AS || 0,
    // Like Windows (RAM + page file); the kernel's CommitLimit only applies in strict overcommit mode.
    commitLimit: (rd('/proc/sys/vm/overcommit_memory') || '').trim() === '2' && m.CommitLimit ? m.CommitLimit : total + (m.SwapTotal || 0),
    swapTotal: m.SwapTotal || 0,
    swapUsed: Math.max(0, (m.SwapTotal || 0) - (m.SwapFree || 0)),
    hardwareReserved: hardwareReserved(total),
  };
}
let physMem = null;
function hardwareReserved(total) {
  if (physMem == null) {
    physMem = 0;
    try {
      const block = parseInt(rd('/sys/devices/system/memory/block_size_bytes') || '0', 16);
      if (block) {
        let online = 0;
        for (const d of fs.readdirSync('/sys/devices/system/memory')) {
          if (d.startsWith('memory') && (rd(`/sys/devices/system/memory/${d}/online`) || '').trim() === '1') online++;
        }
        physMem = online * block;
      }
    } catch {}
  }
  return physMem > total ? physMem - total : 0;
}

// Disks: whole block devices (no partitions, loop, ram, zram, device-mapper, optical).
const SKIP_DISK = /^(loop|ram|zram|dm-|sr|fd|md\d+p|nbd|mtdblock)/;
let diskStatic = { at: 0, list: [] };
function disksStatic() {
  if (Date.now() - diskStatic.at < 10000) return diskStatic.list;
  let names = [];
  try {
    names = fs.readdirSync('/sys/block');
  } catch {}
  const mounts = mountsByDisk(new Set(names));
  const list = [];
  for (const name of names.sort()) {
    if (SKIP_DISK.test(name)) continue;
    const size = Number(rd(`/sys/block/${name}/size`)) * 512;
    if (!size) continue;
    const rot = (rd(`/sys/block/${name}/queue/rotational`) || '').trim() === '1';
    const removable = (rd(`/sys/block/${name}/removable`) || '').trim() === '1';
    const model = ((rd(`/sys/block/${name}/device/model`) || '').trim() || (rd(`/sys/block/${name}/device/name`) || '').trim()).replace(/\s+/g, ' ');
    const m = mounts.get(name) || [];
    list.push({
      name,
      model: model || (/^(vd|xvd)/.test(name) ? 'Virtual disk' : ''),
      type: removable ? 'removable' : /^nvme/.test(name) ? 'ssd' : rot ? 'hdd' : 'ssd',
      size,
      mounts: m.map((x) => x.dir),
      formatted: m.reduce((a, x) => a + (x.size || 0), 0),
      system: m.some((x) => x.dir === '/'),
      swap: swapDisks().has(name),
    });
  }
  diskStatic = { at: Date.now(), list };
  return list;
}
function diskOf(dev, disks, depth = 0) {
  if (depth > 8 || !dev) return null;
  if (disks.has(dev) && !/^dm-|^md/.test(dev)) return [dev];
  let real = '';
  try {
    real = fs.realpathSync(`/sys/class/block/${dev}`);
  } catch {
    return null;
  }
  const parent = path.basename(path.dirname(real));
  if (disks.has(parent) && !/^dm-|^md/.test(parent)) return [parent];
  try {
    const slaves = fs.readdirSync(`/sys/class/block/${dev}/slaves`);
    return slaves.flatMap((s) => diskOf(s, disks, depth + 1) || []);
  } catch {}
  return null;
}
function mountsByDisk(disks) {
  const map = new Map();
  for (const line of (rd('/proc/mounts') || '').split('\n')) {
    const [src, dir] = line.split(' ');
    if (!src?.startsWith('/dev/') || !dir) continue;
    let dev = src;
    try {
      dev = fs.realpathSync(src);
    } catch {}
    const owners = diskOf(path.basename(dev), disks) || [];
    let size = 0;
    try {
      const s = fs.statfsSync(dir.replace(/\\040/g, ' '));
      size = s.blocks * s.bsize;
    } catch {}
    for (const d of owners) {
      if (!map.has(d)) map.set(d, []);
      if (!map.get(d).some((x) => x.dir === dir)) map.get(d).push({ dir: dir.replace(/\\040/g, ' '), size });
    }
  }
  return map;
}
let swapCache = null;
function swapDisks() {
  if (swapCache) return swapCache;
  swapCache = new Set();
  let names = [];
  try {
    names = fs.readdirSync('/sys/block');
  } catch {}
  const set = new Set(names);
  for (const line of (rd('/proc/swaps') || '').split('\n').slice(1)) {
    const src = line.split(/\s+/)[0];
    if (!src?.startsWith('/dev/')) continue;
    let dev = src;
    try {
      dev = fs.realpathSync(src);
    } catch {}
    for (const d of diskOf(path.basename(dev), set) || []) swapCache.add(d);
  }
  setTimeout(() => (swapCache = null), 30000).unref?.();
  return swapCache;
}
function diskCounters() {
  const map = new Map();
  for (const line of (rd('/proc/diskstats') || '').split('\n')) {
    const v = line.trim().split(/\s+/);
    if (v.length < 14) continue;
    map.set(v[2], { reads: +v[3], rsect: +v[5], rms: +v[6], writes: +v[7], wsect: +v[9], wms: +v[10], io: +v[12] });
  }
  return map;
}

// Network adapters: physical (or wireless) interfaces; virtual ones only when nothing physical exists.
let netStatic = { at: 0, list: [] };
function netStaticList() {
  if (Date.now() - netStatic.at < 5000) return netStatic.list;
  let names = [];
  try {
    names = fs.readdirSync('/sys/class/net');
  } catch {}
  const addrs = os.networkInterfaces();
  const all = [];
  for (const name of names.sort()) {
    if (name === 'lo') continue;
    const base = `/sys/class/net/${name}`;
    const wireless = fs.existsSync(`${base}/wireless`) || fs.existsSync(`${base}/phy80211`);
    const physical = fs.existsSync(`${base}/device`);
    const type = Number(rd(`${base}/type`));
    const oper = (rd(`${base}/operstate`) || '').trim();
    const a = addrs[name] || [];
    all.push({
      iface: name,
      type: wireless ? 'wifi' : 'ethernet',
      physical: physical || wireless,
      arp: type,
      up: oper === 'up' || (oper === 'unknown' && a.length > 0),
      speedMbps: Number(rd(`${base}/speed`)) > 0 ? Number(rd(`${base}/speed`)) : null,
      mac: (rd(`${base}/address`) || '').trim(),
      ipv4: a.filter((x) => x.family === 'IPv4' || x.family === 4).map((x) => x.address),
      ipv6: a.filter((x) => x.family === 'IPv6' || x.family === 6).map((x) => x.address),
      driver: path.basename(rl(`${base}/device/driver`) || ''),
    });
  }
  let list = all.filter((n) => n.physical);
  if (!list.length) list = all.filter((n) => n.up && n.arp === 1 && !/^(veth|docker|br-|virbr|ifb)/.test(n.iface));
  netStatic = { at: Date.now(), list };
  return list;
}
function netCounters() {
  const map = new Map();
  for (const line of (rd('/proc/net/dev') || '').split('\n').slice(2)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const v = line.slice(i + 1).trim().split(/\s+/).map(Number);
    map.set(line.slice(0, i).trim(), { rx: v[0], tx: v[8] });
  }
  return map;
}
function wifiSignal(iface) {
  for (const line of (rd('/proc/net/wireless') || '').split('\n').slice(2)) {
    const i = line.indexOf(':');
    if (i > 0 && line.slice(0, i).trim() === iface) {
      const q = parseFloat(line.slice(i + 1).trim().split(/\s+/)[1]);
      return Number.isFinite(q) ? Math.max(0, Math.min(100, Math.round((q / 70) * 100))) : null;
    }
  }
  return null;
}

function gpuInfo() {
  let cards = [];
  try {
    cards = fs.readdirSync('/sys/class/drm').filter((d) => /^card\d+$/.test(d));
  } catch {}
  for (const c of cards) {
    const dev = `/sys/class/drm/${c}/device`;
    const busy = rd(`${dev}/gpu_busy_percent`);
    if (busy == null) continue;
    const used = Number(rd(`${dev}/mem_info_vram_used`)) || 0;
    const total = Number(rd(`${dev}/mem_info_vram_total`)) || 0;
    return { name: c, busyPct: Math.max(0, Math.min(100, Number(busy) || 0)), vramUsed: used, vramTotal: total, driver: path.basename(rl(`${dev}/driver`) || '') };
  }
  return null;
}

const perfState = { prev: null, cache: null, cacheAt: 0, inflight: null };
// The first call primes the counters for a moment so it already reports real rates.
async function snapshot() {
  if (perfState.cache && Date.now() - perfState.cacheAt < 250) return perfState.cache;
  if (perfState.inflight) return perfState.inflight;
  perfState.inflight = (async () => {
    if (!perfState.prev) {
      perfState.prev = { at: Date.now(), cpus: cpuLines(), disks: diskCounters(), net: netCounters() };
      await sleep(200);
    }
    return computeSnapshot();
  })();
  try {
    return await perfState.inflight;
  } finally {
    perfState.inflight = null;
  }
}
function computeSnapshot() {
  const now = Date.now();
  const cpus = cpuLines();
  const disks = diskCounters();
  const net = netCounters();
  const prev = perfState.prev;
  const dt = prev ? Math.max(0.001, (now - prev.at) / 1000) : 0;
  const pct = (a, b) => {
    if (!a || !b) return 0;
    const d = b.total - a.total;
    return d > 0 ? Math.max(0, Math.min(100, (1 - (b.idle - a.idle) / d) * 100)) : 0;
  };
  const sc = cpuInfoStatic();
  const loadavg = (rd('/proc/loadavg') || '').split(' ');
  const handles = Number((rd('/proc/sys/fs/file-nr') || '').split(/\s+/)[0]) || 0;
  let processes = 0;
  try {
    for (const n of fs.readdirSync('/proc')) {
      const c = n.charCodeAt(0);
      if (c >= 48 && c <= 57) processes++;
    }
  } catch {}
  const cpu = {
    total: prev ? pct(prev.cpus[0], cpus[0]) : 0,
    perCore: cpus.slice(1).map((c, i) => (prev ? pct(prev.cpus[i + 1], c) : 0)),
    speedMHz: currentMHz(),
    baseMHz: sc.baseMHz,
    maxMHz: sc.maxMHz,
    model: sc.model,
    cores: sc.cores,
    logical: sc.logical,
    sockets: sc.sockets,
    virtualization: sc.virtualization,
    vm: sc.vm,
    caches: sc.caches,
    processes,
    threads: Number((loadavg[3] || '').split('/')[1]) || 0,
    handles,
    uptime: Number((rd('/proc/uptime') || '0').split(' ')[0]) || os.uptime(),
    loadavg: loadavg.slice(0, 3).map(Number),
  };
  const diskList = disksStatic().map((d) => {
    const c = disks.get(d.name);
    const p = prev?.disks.get(d.name);
    let readBps = 0;
    let writeBps = 0;
    let busyPct = 0;
    let avgResponseMs = 0;
    if (c && p && dt) {
      readBps = Math.max(0, ((c.rsect - p.rsect) * 512) / dt);
      writeBps = Math.max(0, ((c.wsect - p.wsect) * 512) / dt);
      busyPct = Math.max(0, Math.min(100, ((c.io - p.io) / (dt * 1000)) * 100));
      const ops = c.reads - p.reads + (c.writes - p.writes);
      avgResponseMs = ops > 0 ? (c.rms - p.rms + (c.wms - p.wms)) / ops : 0;
    }
    return { ...d, readBps, writeBps, busyPct, avgResponseMs };
  });
  const netList = netStaticList().map((n) => {
    const c = net.get(n.iface);
    const p = prev?.net.get(n.iface);
    const rxBps = c && p && dt ? Math.max(0, ((c.rx - p.rx) * 8) / dt) : 0;
    const txBps = c && p && dt ? Math.max(0, ((c.tx - p.tx) * 8) / dt) : 0;
    const { arp, physical, ...rest } = n;
    return { ...rest, rxBps, txBps, signal: n.type === 'wifi' ? wifiSignal(n.iface) : null };
  });
  perfState.prev = { at: now, cpus, disks, net };
  const snap = { time: now, cpu, mem: meminfo(), disks: diskList, net: netList, gpu: gpuInfo() };
  perfState.cache = snap;
  perfState.cacheAt = now;
  return snap;
}

// ------------------------------------------------------------------ services (systemd)
// Captured from Ubuntu 24.04 (`systemctl list-units --type=service --all --no-legend --plain --no-pager`);
// used in dev mode when systemd is not running so the page can still be exercised.
const SAMPLE_UNITS = `accounts-daemon.service              loaded    active   running Accounts Service
alsa-restore.service                 loaded    inactive dead    Save/Restore Sound Card State
apparmor.service                     loaded    active   exited  Load AppArmor profiles
apport.service                       loaded    active   exited  automatic crash report generation
avahi-daemon.service                 loaded    active   running Avahi mDNS/DNS-SD Stack
bluetooth.service                    loaded    active   running Bluetooth service
colord.service                       loaded    active   running Manage, Install and Generate Color Profiles
console-setup.service                loaded    active   exited  Set console font and keymap
cron.service                         loaded    active   running Regular background program processing daemon
cups-browsed.service                 loaded    active   running Make remote CUPS printers available locally
cups.service                         loaded    active   running CUPS Scheduler
dbus.service                         loaded    active   running D-Bus System Message Bus
dmesg.service                        loaded    inactive dead    Save initial kernel messages after boot
fwupd.service                        loaded    inactive dead    Firmware update daemon
getty@tty1.service                   loaded    active   running Getty on tty1
greetd.service                       loaded    active   running Greeter daemon
● gpu-manager.service                  not-found inactive dead    gpu-manager.service
kerneloops.service                   loaded    active   running Tool to automatically collect and submit kernel crash signatures
keyboard-setup.service               loaded    active   exited  Set the console keyboard layout
ModemManager.service                 loaded    active   running Modem Manager
networkd-dispatcher.service          loaded    active   running Dispatcher daemon for systemd-networkd
NetworkManager-wait-online.service   loaded    active   exited  Network Manager Wait Online
NetworkManager.service               loaded    active   running Network Manager
● plymouth-quit-wait.service           loaded    failed   failed  Hold until boot process finishes up
plymouth-read-write.service          loaded    active   exited  Tell Plymouth To Write Out Runtime Data
polkit.service                       loaded    active   running Authorization Manager
power-profiles-daemon.service        loaded    active   running Power Profiles daemon
rsyslog.service                      loaded    active   running System Logging Service
rtkit-daemon.service                 loaded    active   running RealtimeKit Scheduling Policy Service
snapd.service                        loaded    inactive dead    Snap Daemon
ssh.service                          loaded    inactive dead    OpenBSD Secure Shell server
switcheroo-control.service           loaded    active   running Switcheroo Control Proxy service
systemd-journal-flush.service        loaded    active   exited  Flush Journal to Persistent Storage
systemd-journald.service             loaded    active   running Journal Service
systemd-logind.service               loaded    active   running User Login Management
systemd-oomd.service                 loaded    active   running Userspace Out-Of-Memory (OOM) Killer
systemd-resolved.service             loaded    active   running Network Name Resolution
systemd-timesyncd.service            loaded    active   running Network Time Synchronization
systemd-udevd.service                loaded    active   running Rule-based Manager for Device Events and Files
thermald.service                     loaded    activating start   Thermal Daemon Service
udisks2.service                      loaded    active   running Disk Manager
unattended-upgrades.service          loaded    active   running Unattended Upgrades Shutdown
upower.service                       loaded    active   running Daemon for power management
user@1000.service                    loaded    active   running User Manager for UID 1000
wpa_supplicant.service               loaded    active   running WPA supplicant`;

const SAMPLE_UNIT_FILES = `accounts-daemon.service enabled enabled
alsa-restore.service static -
apparmor.service enabled enabled
avahi-daemon.service enabled enabled
bluetooth.service enabled enabled
cron.service enabled enabled
cups.service enabled enabled
dbus.service static -
fwupd.service static -
getty@.service enabled enabled
greetd.service enabled enabled
NetworkManager.service enabled enabled
polkit.service static -
rsyslog.service enabled enabled
snapd.service disabled enabled
ssh.service disabled enabled
systemd-journald.service static -
systemd-logind.service static -
udisks2.service enabled enabled
upower.service disabled enabled
wpa_supplicant.service enabled enabled`;

function parseListUnits(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^\s*[●*×]\s*/, '').trim();
    if (!line) continue;
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m || !m[1].endsWith('.service')) continue;
    out.push({ unit: m[1], name: m[1].replace(/\.service$/, ''), load: m[2], active: m[3], sub: m[4], description: m[5].trim() });
  }
  return out;
}
function parseUnitFiles(text) {
  const map = new Map();
  for (const raw of String(text || '').split('\n')) {
    const p = raw.trim().split(/\s+/);
    if (p.length >= 2 && p[0].endsWith('.service')) map.set(p[0], p[1]);
  }
  return map;
}
function servicePids() {
  const byUnit = new Map();
  const ppid = new Map();
  for (const pid of listPids()) {
    const unit = unitOfPid(pid);
    if (!unit || !unit.endsWith('.service')) continue;
    const st = parseStat(rd(`/proc/${pid}/stat`) || '');
    if (!st || (st.flags & PF_KTHREAD) !== 0) continue;
    ppid.set(pid, st.ppid);
    if (!byUnit.has(unit)) byUnit.set(unit, []);
    byUnit.get(unit).push(pid);
  }
  const main = new Map();
  for (const [unit, pids] of byUnit) {
    const set = new Set(pids);
    const roots = pids.filter((p) => !set.has(ppid.get(p))).sort((a, b) => a - b);
    main.set(unit, { pid: roots[0] ?? pids[0], pids });
  }
  return main;
}
function mergeServices(units, files, pids) {
  const seen = new Set();
  const out = units.map((u) => {
    seen.add(u.unit);
    const tmpl = u.unit.replace(/@[^.]+\.service$/, '@.service');
    return { ...u, startup: files.get(u.unit) || files.get(tmpl) || '', pid: u.sub === 'running' || u.active === 'active' ? pids.get(u.unit)?.pid ?? null : null };
  });
  for (const [unit, state] of files) {
    if (seen.has(unit) || unit.includes('@.')) continue;
    out.push({ unit, name: unit.replace(/\.service$/, ''), load: 'unloaded', active: 'inactive', sub: 'dead', description: '', startup: state, pid: null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
let svcCache = { at: 0, value: null };
async function services(api) {
  if (svcCache.value && Date.now() - svcCache.at < 1500) return svcCache.value;
  let units = null;
  let filesText = '';
  try {
    const r = await run('systemctl', ['list-units', '--type=service', '--all', '--no-legend', '--plain', '--no-pager'], { timeout: 10000 });
    if (r.code === 0) {
      units = parseListUnits(r.stdout);
      const f = await run('systemctl', ['list-unit-files', '--type=service', '--no-legend', '--no-pager'], { timeout: 10000 }).catch(() => null);
      filesText = f?.code === 0 ? f.stdout : '';
    } else if (!api.DEV) throw api.error((r.stderr || 'systemctl failed').trim(), 'ESYSTEMD');
  } catch (err) {
    if (!api.DEV) throw err.code === 'ENOENT' ? api.error('systemd is not available', 'ESYSTEMD') : err;
  }
  let value;
  if (units) value = { mock: false, services: mergeServices(units, parseUnitFiles(filesText), servicePids()) };
  else value = { mock: true, services: mergeServices(parseListUnits(SAMPLE_UNITS), parseUnitFiles(SAMPLE_UNIT_FILES), new Map()) };
  svcCache = { at: Date.now(), value };
  return value;
}

// ------------------------------------------------------------------ users
function parseShowBlocks(text) {
  const out = [];
  let cur = {};
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) {
      if (Object.keys(cur).length) out.push(cur);
      cur = {};
      continue;
    }
    const i = line.indexOf('=');
    if (i > 0) cur[line.slice(0, i)] = line.slice(i + 1);
  }
  if (Object.keys(cur).length) out.push(cur);
  return out;
}
async function usersList(api) {
  const pwd = passwd();
  const byUid = new Map();
  const add = (uid) => {
    if (!byUid.has(uid)) {
      const e = pwd.get(uid);
      byUid.set(uid, { uid, user: e?.name ?? String(uid), fullName: e?.fullName || e?.name || String(uid), status: '', sessions: [] });
    }
    return byUid.get(uid);
  };
  try {
    const r = await run('loginctl', ['list-sessions', '--no-legend', '--no-pager'], { timeout: 5000 });
    const ids = r.code === 0 ? r.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean) : [];
    if (ids.length) {
      const s = await run('loginctl', ['show-session', ...ids, '-p', 'Id', '-p', 'User', '-p', 'Name', '-p', 'State', '-p', 'Active', '-p', 'Type', '-p', 'Class', '-p', 'Remote', '-p', 'TTY', '-p', 'Seat', '-p', 'Timestamp'], { timeout: 5000 });
      for (const b of parseShowBlocks(s.stdout)) {
        if (b.Class && b.Class !== 'user') continue;
        const u = add(Number(b.User));
        u.sessions.push({ id: b.Id, state: b.State || '', active: b.Active === 'yes', type: b.Type || '', tty: b.TTY || '', seat: b.Seat || '', remote: b.Remote === 'yes', since: b.Timestamp ? Date.parse(b.Timestamp) || null : null });
      }
    }
  } catch {}
  // Users with processes but no logind session (no systemd, containers): the shell's own user at least.
  const me = process.getuid?.() ?? -1;
  if (me >= 0) add(me);
  for (const pid of listPids()) {
    let uid = -1;
    try {
      uid = fs.statSync(`/proc/${pid}`).uid;
    } catch {
      continue;
    }
    if (uid >= 1000 && uid < 60000) add(uid);
  }
  for (const u of byUid.values()) {
    const states = u.sessions.map((s) => s.state);
    u.status = states.includes('active') || u.sessions.some((s) => s.active) ? 'active' : states.includes('online') ? 'online' : states.includes('closing') ? 'closing' : u.uid === me ? 'active' : u.sessions.length ? 'disconnected' : '';
  }
  return [...byUid.values()].sort((a, b) => (a.uid === me ? -1 : b.uid === me ? 1 : a.user.localeCompare(b.user)));
}

// ------------------------------------------------------------------ startup apps (XDG autostart)
function configHome() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}
function systemAutostartDirs() {
  return (process.env.XDG_CONFIG_DIRS || '/etc/xdg')
    .split(':')
    .filter(Boolean)
    .map((d) => path.join(d, 'autostart'));
}
function parseDesktop(text) {
  const out = {};
  let inMain = false;
  for (const line of String(text || '').split('\n')) {
    const l = line.trim();
    if (l.startsWith('[')) {
      inMain = l === '[Desktop Entry]';
      continue;
    }
    if (!inMain || !l || l.startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}
function entryEnabled(e) {
  if (!e) return true;
  if (/^true$/i.test(e.Hidden || '')) return false;
  if (/^false$/i.test(e['X-GNOME-Autostart-enabled'] || '')) return false;
  return true;
}
function startupList(lang = 'en') {
  const userDir = path.join(configHome(), 'autostart');
  const byId = new Map();
  for (const dir of [...systemAutostartDirs().reverse(), userDir]) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.desktop'));
    } catch {}
    for (const f of files) {
      const e = parseDesktop(rd(path.join(dir, f)));
      const prev = byId.get(f);
      byId.set(f, { id: f, sys: dir === userDir ? prev?.sys || null : e, user: dir === userDir ? e : prev?.user || null });
    }
  }
  const out = [];
  for (const { id, sys, user } of byId.values()) {
    const e = { ...(sys || {}), ...(user || {}) };
    if (!e.Name && !e.Exec) continue;
    const only = (e.OnlyShowIn || '').split(';').filter(Boolean);
    const not = (e.NotShowIn || '').split(';').filter(Boolean);
    out.push({
      id,
      name: e[`Name[${lang}]`] || e.Name || id.replace(/\.desktop$/, ''),
      comment: e[`Comment[${lang}]`] || e.Comment || '',
      exec: e.Exec || '',
      icon: e.Icon || '',
      enabled: entryEnabled(user) && entryEnabled(sys && !user ? sys : null) && !(user && /^true$/i.test(user.Hidden || '')),
      scope: sys ? 'system' : 'user',
      desktopOnly: only.length ? only.join(', ') : '',
      excluded: (only.length > 0 && !only.includes('Aurora')) || not.includes('Aurora'),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
function startupSet(api, id, enabled) {
  id = path.basename(String(id || ''));
  if (!id.endsWith('.desktop')) throw api.error('Invalid startup entry', 'EINVAL');
  const userDir = path.join(configHome(), 'autostart');
  const userFile = path.join(userDir, id);
  let base = rd(userFile);
  if (base == null) {
    for (const d of systemAutostartDirs()) {
      base = rd(path.join(d, id));
      if (base != null) break;
    }
  }
  if (base == null) throw api.error('This startup entry no longer exists', 'ENOENT');
  const lines = base.split('\n').filter((l) => !/^\s*(Hidden|X-GNOME-Autostart-enabled)\s*=/.test(l));
  const idx = lines.findIndex((l) => l.trim() === '[Desktop Entry]');
  const extra = enabled ? ['X-GNOME-Autostart-enabled=true'] : ['Hidden=true', 'X-GNOME-Autostart-enabled=false'];
  if (idx >= 0) lines.splice(idx + 1, 0, ...extra);
  else lines.unshift('[Desktop Entry]', ...extra);
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(userFile, lines.join('\n').replace(/\n*$/, '\n'));
  return true;
}

// ------------------------------------------------------------------ registration
function register(api) {
  run('getconf', ['PAGESIZE'])
    .then((r) => {
      const v = Number(r.stdout.trim());
      if (v > 0) PAGE = v;
    })
    .catch(() => {});
  run('getconf', ['CLK_TCK'])
    .then((r) => {
      const v = Number(r.stdout.trim());
      if (v > 0) CLK_TCK = v;
    })
    .catch(() => {});

  api.handle('proc:list', () => procList());
  api.handle('proc:shell', () => shellProcesses());
  api.handle('proc:info', (pid) => {
    try {
      return procInfo(pid);
    } catch (err) {
      throw api.error(err.message, err.code || 'EFAIL');
    }
  });
  api.handle('proc:alive', (pids) => {
    const out = {};
    for (const p of Array.isArray(pids) ? pids : [pids]) {
      const st = parseStat(rd(`/proc/${Number(p)}/stat`) || '');
      out[p] = !!st && st.state !== 'Z' && st.state !== 'X';
    }
    return out;
  });
  api.handle('proc:kill', (pid, signal = 'SIGTERM') => {
    if (!SIGNALS.has(signal)) throw api.error(`Unsupported signal ${signal}`, 'EINVAL');
    return killOne(api, Number(pid), signal);
  });
  api.handle('proc:killTree', (pid, signal = 'SIGTERM') => {
    if (!SIGNALS.has(signal)) throw api.error(`Unsupported signal ${signal}`, 'EINVAL');
    pid = Number(pid);
    checkTarget(api, pid);
    const killed = [];
    const failed = [];
    for (const p of [...descendants(pid, process.pid), pid]) {
      if (p === process.pid) continue; // never take the shell (or its own processes) down as a side effect
      try {
        killOne(api, p, signal);
        killed.push(p);
      } catch (err) {
        if (err.code !== 'ESRCH') failed.push({ pid: p, code: err.code });
      }
    }
    return { killed, failed };
  });
  api.handle('proc:setPriority', (pid, nice) => setPriority(api, pid, nice));
  api.handle('proc:spawn', (line) => spawnCommand(api, line));
  api.handle('perf:snapshot', () => snapshot());
  api.handle('perf:services', () => services(api));
  api.handle('perf:users', () => usersList(api));
  api.handle('perf:startup', (lang) => ({ bootTime: bootTimeMs(), entries: startupList(lang === 'fr' ? 'fr' : 'en') }));
  api.handle('perf:startupSet', (id, enabled) => startupSet(api, id, !!enabled));
}

module.exports = register;
// Pure helpers, exported for tests (test/taskmgr.test.mjs).
module.exports.parseListUnits = parseListUnits;
module.exports.parseUnitFiles = parseUnitFiles;
module.exports.mergeServices = mergeServices;
module.exports.parseStat = parseStat;
module.exports.parseDesktop = parseDesktop;
module.exports.splitCommand = splitCommand;
module.exports.descendants = descendants;
module.exports.SAMPLE_UNITS = SAMPLE_UNITS;
