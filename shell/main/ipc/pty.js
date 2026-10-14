'use strict';
// Aurora Terminal backend: pseudo-terminals without native node modules. Each terminal is one
// /usr/lib/aurora/helpers/aurora-pty process (python3, stdlib only) that forks the program on a
// real PTY and relays it over pipes: stdin = input, stdout = output, fd 3 = control ("resize c r").
//
//   pty:spawn({ cols, rows, cwd, command }) -> id
//       command: undefined -> the user's login shell (login shell, from /etc/passwd)
//                'htop -d 5' -> run by the user's shell (-c)      ['python3'] -> exec'd directly
//   aurora.send('pty:write', id, data[, 'binary'])   input (fire and forget)
//   aurora.send('pty:ack', id, chars)      flow control: the renderer has processed `chars` of output
//   pty:resize(id, cols, rows)  pty:signal(id, 'INT')  pty:kill(id)
//   pty:info(id) -> { pid, fgPid, fgName, busy, cwd }    busy: a program other than the shell runs
//   pty:env() -> { shell, shellName, user, home, hostname, python, sudo, version }
//   pty:fonts() -> installed monospace font families (fontconfig), [] when unknown
//   cwd: absolute, '~', '~/dir', or relative to the home folder; anything that is not a folder -> home
//   pty:primaryRead() -> text   pty:primaryWrite(text)   the X11 PRIMARY selection (middle-click paste)
// Events, sent only to the renderer that spawned the terminal:
//   'pty:data' { id, data }       output decoded with a streaming UTF-8 decoder, batched every ~8 ms
//   'pty:proc' { id, pid, name, busy }   the foreground program changed (polled once a second)
//   'pty:exit' { id, code }       after the last 'pty:data'
// Output is paused while more than HIGH characters wait for an ack, so a flood (yes, cat of a big
// file) cannot swamp the renderer; the helper then stops reading the PTY and the program blocks.
// The IPC framework appends the event after the arguments, so every handler takes it from the end of
// the argument list (a call with a missing or extra argument must never shift it into another one and
// skip the ownership check).
// Terminals die with their renderer (closed, reloaded, crashed) and when the app quits; if the
// shell process itself dies the helper sees EOF on stdin and hangs its terminal up.
const { app, clipboard } = require('electron');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { helperPath, which, run } = require('../lib/exec');

const FLUSH_MS = 8;
const MAX_BATCH = 256 * 1024;
const HIGH = 512 * 1024;
const LOW = 128 * 1024;
const KILL_GRACE = 4000;
const SIGNALS = new Set(['INT', 'TERM', 'HUP', 'QUIT', 'TSTP', 'CONT', 'KILL', 'WINCH', 'USR1', 'USR2']);

const ptys = new Map(); // id -> state
const owners = new Map(); // webContents id -> Set(id)
let seq = 0;
let procTimer = null;

function clampInt(v, lo, hi, def) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
}

// '~', '~/src', 'src' (relative to home) or an absolute path -> an existing folder, else home.
function resolveCwd(cwd) {
  const home = os.homedir();
  let dir = typeof cwd === 'string' ? cwd.trim() : '';
  if (!dir || dir.includes('\0')) return home;
  if (dir === '~') dir = home;
  else if (dir.startsWith('~/')) dir = path.join(home, dir.slice(2));
  else if (!path.isAbsolute(dir)) dir = path.join(home, dir);
  try {
    return fs.statSync(dir).isDirectory() ? dir : home;
  } catch {
    return home;
  }
}

// Monospace font families known to fontconfig, for the font face setting.
let fontsPromise = null;
function monoFonts() {
  if (!fontsPromise) {
    fontsPromise = run('fc-list', [':spacing=mono', 'family'], { timeout: 8000 })
      .then(({ stdout }) => {
        const set = new Set();
        for (const line of stdout.split('\n')) {
          const name = line.split(',')[0].replace(/\\/g, '').trim();
          if (name && !/emoji|symbol/i.test(name)) set.add(name);
        }
        return [...set].sort((a, b) => a.localeCompare(b));
      })
      .catch(() => []);
  }
  return fontsPromise;
}

function loginShell() {
  // tests pin the shell (same variable as rootfs/usr/lib/aurora/helpers/aurora-pty), whatever the developer's own is
  const forced = process.env.AURORA_PTY_LOGIN_SHELL || '';
  if (forced.startsWith('/') && fs.existsSync(forced)) return forced;
  try {
    const uid = process.getuid?.() ?? -1;
    for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const f = line.split(':');
      if (f.length >= 7 && Number(f[2]) === uid) {
        const sh = f[6].trim();
        if (sh && !/(nologin|false)$/.test(sh) && fs.existsSync(sh)) return sh;
      }
    }
  } catch {}
  return fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

function childEnv(api) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(ELECTRON_|CHROME_|GOOGLE_|npm_|NODE_OPTIONS$|NODE_ENV$|AURORA_ENV$|INIT_CWD$)/.test(k)) delete env[k];
  }
  if (env.ORIGINAL_XDG_CURRENT_DESKTOP) {
    env.XDG_CURRENT_DESKTOP = env.ORIGINAL_XDG_CURRENT_DESKTOP;
    delete env.ORIGINAL_XDG_CURRENT_DESKTOP;
  }
  if (!env.LANG) env.LANG = 'C.UTF-8';
  env.TERM_PROGRAM = 'aurora-terminal';
  env.TERM_PROGRAM_VERSION = String(api.env?.version || '1.0');
  env.AURORA_TERMINAL = '1';
  env.HOME = env.HOME || os.homedir();
  // Development machines do not have the image's /etc/profile.d/aurora-prompt.sh: load the repo copy
  // so the prompt looks like the real thing (it removes this hook on the first prompt).
  if (api.DEV && !fs.existsSync('/etc/profile.d/aurora-prompt.sh')) {
    const dev = path.join(__dirname, '..', '..', '..', 'rootfs', 'etc', 'profile.d', 'aurora-prompt.sh');
    if (fs.existsSync(dev)) env.PROMPT_COMMAND = `. '${dev.replace(/'/g, "'\\''")}'; __aurora_prompt_init`;
  }
  return env;
}

function helperCommand(args) {
  const helper = helperPath('aurora-pty');
  try {
    fs.accessSync(helper, fs.constants.X_OK);
    return [helper, args];
  } catch {}
  const py = which('python3');
  if (!py || !fs.existsSync(helper)) {
    const e = new Error('The terminal helper (aurora-pty) or python3 is missing');
    e.code = 'ENOPTY';
    throw e;
  }
  return [py, ['-I', helper, ...args]];
}

function readStat(pid) {
  // "pid (comm) state ppid pgrp session tty_nr tpgid ..." — comm may contain spaces and parentheses.
  const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
  return { ppid: Number(rest[1]), pgrp: Number(rest[2]), session: Number(rest[3]), tpgid: Number(rest[5]) };
}

function procName(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return '';
  }
}

// The program in the foreground of a terminal. An interactive shell gives each job its own process
// group (tpgid != shell); a non-interactive one (bash -c "make; ./run") keeps its children in its own
// group, so look for a child of the shell in the foreground group too.
function foreground(p) {
  if (!p.shellPid || p.exited) return null;
  try {
    const st = readStat(p.shellPid);
    const fgPid = st.tpgid > 0 ? st.tpgid : p.shellPid;
    if (fgPid !== p.shellPid) return { fgPid, fgName: procName(fgPid) || procName(p.shellPid), busy: true };
    let kids = [];
    try {
      kids = fs.readFileSync(`/proc/${p.shellPid}/task/${p.shellPid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
    } catch {}
    for (const kid of kids) {
      try {
        if (readStat(kid).pgrp === fgPid) return { fgPid: kid, fgName: procName(kid), busy: true };
      } catch {}
    }
    return { fgPid, fgName: procName(p.shellPid), busy: false };
  } catch {
    return null;
  }
}

function pollProcs(api) {
  for (const p of ptys.values()) {
    const fg = foreground(p);
    if (!fg) continue;
    const key = `${fg.fgPid}:${fg.fgName}`;
    if (key !== p.fgKey) {
      p.fgKey = key;
      api.sendTo(p.owner, 'pty:proc', { id: p.id, pid: fg.fgPid, name: fg.fgName, busy: fg.busy });
    }
  }
}

function ensurePolling(api) {
  if (procTimer || !ptys.size) return;
  procTimer = setInterval(() => {
    if (!ptys.size) {
      clearInterval(procTimer);
      procTimer = null;
      return;
    }
    pollProcs(api);
  }, 1000);
  procTimer.unref?.();
}

function flush(api, p) {
  clearTimeout(p.timer);
  p.timer = null;
  if (!p.pending.length) return;
  const data = p.pending.join('');
  p.pending = [];
  p.pendingLen = 0;
  p.unacked += data.length;
  api.sendTo(p.owner, 'pty:data', { id: p.id, data });
  if (p.unacked > HIGH && !p.paused && p.child.stdout && !p.child.stdout.destroyed) {
    p.paused = true;
    p.child.stdout.pause();
  }
}

function killPty(p, { force = false } = {}) {
  if (!p || p.exited) return;
  // Nobody wants the rest of the output: drain it so a paused (flow-controlled) helper can finish.
  p.discard = true;
  clearTimeout(p.timer);
  p.pending = [];
  try {
    p.child.stdout.resume();
  } catch {}
  try {
    p.child.stdin.end();
  } catch {}
  try {
    p.child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch {}
  if (!force && !p.killTimer) {
    p.killTimer = setTimeout(() => {
      if (!p.exited) {
        try {
          p.child.kill('SIGKILL');
        } catch {}
      }
    }, KILL_GRACE);
    p.killTimer.unref?.();
  }
}

function killOwner(wcId) {
  const set = owners.get(wcId);
  if (!set) return;
  for (const id of set) killPty(ptys.get(id));
}

function trackOwner(sender) {
  const wcId = sender.id;
  if (owners.has(wcId)) return owners.get(wcId);
  const set = new Set();
  owners.set(wcId, set);
  const drop = () => killOwner(wcId);
  sender.once('destroyed', () => {
    drop();
    owners.delete(wcId);
  });
  sender.on('render-process-gone', drop);
  // A reload of the shell page: its terminals are gone with the old page.
  sender.on('did-navigate', drop);
  return set;
}

module.exports = function register(api) {
  // handle(channel, (event, ...args) => …): the IPC event is always the last argument.
  const handle = (channel, fn) =>
    api.handle(channel, (...args) => {
      const event = args.pop();
      if (!event?.sender) throw api.error('No renderer', 'EINVAL');
      return fn(event, ...args);
    });
  const listen = (channel, fn) =>
    api.on(channel, (...args) => {
      const event = args.pop();
      if (event?.sender) fn(event, ...args);
    });

  handle('pty:spawn', (event, opts) => {
    const sender = event.sender;
    if (!opts || typeof opts !== 'object') opts = {};
    const wcId = sender.id;
    const cols = clampInt(opts.cols, 2, 1000, 80);
    const rows = clampInt(opts.rows, 1, 500, 24);
    const cwd = resolveCwd(opts.cwd);
    const args = ['--cols', String(cols), '--rows', String(rows), '--cwd', cwd, '--'];
    const command = opts.command;
    if (Array.isArray(command) && command.length) {
      if (!command.every((a) => typeof a === 'string')) throw api.error('Invalid command', 'EINVAL');
      if (command.some((a) => a.includes('\0'))) throw api.error('Invalid command', 'EINVAL');
      args.push(...command);
    } else if (typeof command === 'string' && command.trim()) {
      if (command.includes('\0')) throw api.error('Invalid command', 'EINVAL');
      args.push(loginShell(), '-c', command);
    } else if (command != null && !(Array.isArray(command) || typeof command === 'string')) {
      throw api.error('Invalid command', 'EINVAL');
    }
    const [bin, argv] = helperCommand(args);
    const child = spawn(bin, argv, { cwd, env: childEnv(api), stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const id = `pty${++seq}`;
    const p = {
      id,
      child,
      owner: sender,
      decoder: new StringDecoder('utf8'),
      pending: [],
      pendingLen: 0,
      timer: null,
      unacked: 0,
      paused: false,
      shellPid: 0,
      exited: false,
      fgKey: '',
      killTimer: null,
      discard: false,
    };
    ptys.set(id, p);
    trackOwner(sender).add(id);
    child.stdin.on('error', () => {});
    child.stdio[3]?.on('error', () => {});
    child.stdout.on('data', (buf) => {
      if (p.discard) return;
      const s = p.decoder.write(buf);
      if (!s) return;
      p.pending.push(s);
      p.pendingLen += s.length;
      if (p.pendingLen >= MAX_BATCH) flush(api, p);
      else if (!p.timer) p.timer = setTimeout(() => flush(api, p), FLUSH_MS);
    });
    let errBuf = '';
    child.stderr.on('data', (buf) => {
      errBuf += String(buf);
      let nl;
      while ((nl = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, nl);
        errBuf = errBuf.slice(nl + 1);
        const m = /^@pid (\d+)$/.exec(line);
        if (m) {
          p.shellPid = Number(m[1]);
          ensurePolling(api);
        } else if (line.trim()) console.warn(`[pty] ${line}`);
      }
    });
    let spawnError = null;
    child.on('error', (err) => {
      spawnError = err;
      console.error('[pty] helper failed:', err.message);
    });
    child.on('close', (code, signal) => {
      p.exited = true;
      clearTimeout(p.killTimer);
      const tail = p.decoder.end();
      if (tail && !p.discard) p.pending.push(tail);
      if (spawnError && !p.pending.length) p.pending.push(`\r\n${spawnError.message}\r\n`);
      flush(api, p);
      ptys.delete(id);
      owners.get(wcId)?.delete(id); // (the renderer may be destroyed by now: no sender.id)
      const exit = code ?? (signal ? 128 + (os.constants.signals[signal] || 1) : 1);
      api.sendTo(sender, 'pty:exit', { id, code: exit });
    });
    return id;
  });

  // aurora.send('pty:write', id, data[, 'binary']) — 'binary': one byte per char code (xterm onBinary).
  listen('pty:write', (event, id, data, mode) => {
    const p = ptys.get(id);
    if (!p || p.exited || p.owner !== event.sender || typeof data !== 'string') return;
    if (p.child.stdin.destroyed) return;
    p.child.stdin.write(mode === 'binary' ? Buffer.from(data, 'latin1') : data);
  });

  listen('pty:ack', (event, id, chars) => {
    const p = ptys.get(id);
    if (!p || p.owner !== event.sender) return;
    p.unacked = Math.max(0, p.unacked - (Number(chars) || 0));
    if (p.paused && p.unacked < LOW) {
      p.paused = false;
      p.child.stdout.resume();
    }
  });

  function own(id, event) {
    const p = ptys.get(id);
    if (!p || p.exited) throw api.error(`No terminal ${id}`, 'ENOENT');
    if (p.owner !== event.sender) throw api.error('Not your terminal', 'EPERM');
    return p;
  }

  handle('pty:resize', (event, id, cols, rows) => {
    const p = own(id, event);
    const c = clampInt(cols, 2, 1000, 80);
    const r = clampInt(rows, 1, 500, 24);
    p.child.stdio[3]?.write(`resize ${c} ${r}\n`);
    return true;
  });

  handle('pty:signal', (event, id, name) => {
    const p = own(id, event);
    const sig = String(name || '').toUpperCase().replace(/^SIG/, '');
    if (!SIGNALS.has(sig)) throw api.error(`Signal ${name} not allowed`, 'EINVAL');
    p.child.stdio[3]?.write(`signal ${sig}\n`);
    return true;
  });

  handle('pty:kill', (event, id) => {
    const p = ptys.get(id);
    if (!p) return false;
    if (p.owner !== event.sender) throw api.error('Not your terminal', 'EPERM');
    killPty(p);
    return true;
  });

  handle('pty:info', (event, id) => {
    const p = own(id, event);
    const fg = foreground(p) || { fgPid: p.shellPid, fgName: '', busy: false };
    let cwd = null;
    try {
      if (p.shellPid) cwd = fs.readlinkSync(`/proc/${p.shellPid}/cwd`);
    } catch {}
    return { pid: p.shellPid, ...fg, cwd };
  });

  handle('pty:fonts', () => monoFonts());

  handle('pty:env', () => {
    const shell = loginShell();
    return {
      shell,
      shellName: path.basename(shell),
      user: os.userInfo().username,
      home: os.homedir(),
      hostname: os.hostname(),
      python: !!which('python3'),
      sudo: !!which('sudo'),
      version: String(api.env?.version || ''),
    };
  });

  handle('pty:primaryRead', () => {
    try {
      return clipboard.readText('selection');
    } catch {
      return '';
    }
  });
  handle('pty:primaryWrite', (event, text) => {
    try {
      clipboard.writeText(String(text ?? '').slice(0, 4 * 1024 * 1024), 'selection');
    } catch {}
    return true;
  });

  const killAll = () => {
    for (const p of ptys.values()) killPty(p);
  };
  app.on('before-quit', killAll);
  app.on('will-quit', killAll);
  process.on('exit', () => {
    for (const p of ptys.values()) {
      try {
        p.child.kill('SIGTERM');
      } catch {}
    }
  });
};

// For tests (plain node, no Electron): which helper would be run.
module.exports.__test = { helperCommand, loginShell, resolveCwd };
