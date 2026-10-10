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
//   pty:primaryRead() -> text   pty:primaryWrite(text)   the X11 PRIMARY selection (middle-click paste)
// Events, sent only to the renderer that spawned the terminal:
//   'pty:data' { id, data }       output decoded with a streaming UTF-8 decoder, batched every ~8 ms
//   'pty:proc' { id, pid, name, busy }   the foreground program changed (polled once a second)
//   'pty:exit' { id, code }       after the last 'pty:data'
// Output is paused while more than HIGH characters wait for an ack, so a flood (yes, cat of a big
// file) cannot swamp the renderer; the helper then stops reading the PTY and the program blocks.
// Terminals die with their renderer (closed, reloaded, crashed) and when the app quits; if the
// shell process itself dies the helper sees EOF on stdin and hangs its terminal up.
const { app, clipboard } = require('electron');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { helperPath, which } = require('../lib/exec');

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

function loginShell() {
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

function foreground(p) {
  if (!p.shellPid || p.exited) return null;
  try {
    const st = readStat(p.shellPid);
    const fgPid = st.tpgid > 0 ? st.tpgid : p.shellPid;
    return { fgPid, fgName: procName(fgPid) || procName(p.shellPid), busy: fgPid !== p.shellPid };
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
  api.handle('pty:spawn', (opts = {}, event) => {
    const sender = event?.sender;
    if (!sender) throw api.error('No renderer', 'EINVAL');
    const cols = clampInt(opts.cols, 2, 1000, 80);
    const rows = clampInt(opts.rows, 1, 500, 24);
    let cwd = typeof opts.cwd === 'string' && opts.cwd ? opts.cwd : os.homedir();
    try {
      if (!fs.statSync(cwd).isDirectory()) cwd = os.homedir();
    } catch {
      cwd = os.homedir();
    }
    const args = ['--cols', String(cols), '--rows', String(rows), '--cwd', cwd, '--'];
    const command = opts.command;
    if (Array.isArray(command) && command.length) {
      if (!command.every((a) => typeof a === 'string')) throw api.error('Invalid command', 'EINVAL');
      args.push(...command);
    } else if (typeof command === 'string' && command.trim()) {
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
    };
    ptys.set(id, p);
    trackOwner(sender).add(id);
    child.stdin.on('error', () => {});
    child.stdio[3]?.on('error', () => {});
    child.stdout.on('data', (buf) => {
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
      if (tail) p.pending.push(tail);
      if (spawnError && !p.pending.length) p.pending.push(`\r\n${spawnError.message}\r\n`);
      flush(api, p);
      ptys.delete(id);
      owners.get(sender.id)?.delete(id);
      const exit = code ?? (signal ? 128 + (os.constants.signals[signal] || 1) : 1);
      api.sendTo(sender, 'pty:exit', { id, code: exit });
    });
    return id;
  });

  // aurora.send('pty:write', id, data[, 'binary']) — 'binary': one byte per char code (xterm onBinary).
  api.on('pty:write', (id, data, ...rest) => {
    const event = rest.pop();
    const p = ptys.get(id);
    if (!p || p.exited || p.owner !== event?.sender || typeof data !== 'string') return;
    if (p.child.stdin.destroyed) return;
    p.child.stdin.write(rest[0] === 'binary' ? Buffer.from(data, 'latin1') : data);
  });

  api.on('pty:ack', (id, chars, event) => {
    const p = ptys.get(id);
    if (!p || p.owner !== event?.sender) return;
    p.unacked = Math.max(0, p.unacked - (Number(chars) || 0));
    if (p.paused && p.unacked < LOW) {
      p.paused = false;
      p.child.stdout.resume();
    }
  });

  function own(id, event) {
    const p = ptys.get(id);
    if (!p || p.exited) throw api.error(`No terminal ${id}`, 'ENOENT');
    if (event?.sender && p.owner !== event.sender) throw api.error('Not your terminal', 'EPERM');
    return p;
  }

  api.handle('pty:resize', (id, cols, rows, event) => {
    const p = own(id, event);
    const c = clampInt(cols, 2, 1000, 80);
    const r = clampInt(rows, 1, 500, 24);
    p.child.stdio[3]?.write(`resize ${c} ${r}\n`);
    return true;
  });

  api.handle('pty:signal', (id, name, event) => {
    const p = own(id, event);
    const sig = String(name || '').toUpperCase().replace(/^SIG/, '');
    if (!SIGNALS.has(sig)) throw api.error(`Signal ${name} not allowed`, 'EINVAL');
    p.child.stdio[3]?.write(`signal ${sig}\n`);
    return true;
  });

  api.handle('pty:kill', (id, event) => {
    const p = ptys.get(id);
    if (!p) return false;
    if (event?.sender && p.owner !== event.sender) throw api.error('Not your terminal', 'EPERM');
    killPty(p);
    return true;
  });

  api.handle('pty:info', (id, event) => {
    const p = own(id, event);
    const fg = foreground(p) || { fgPid: p.shellPid, fgName: '', busy: false };
    let cwd = null;
    try {
      if (p.shellPid) cwd = fs.readlinkSync(`/proc/${p.shellPid}/cwd`);
    } catch {}
    return { pid: p.shellPid, ...fg, cwd };
  });

  api.handle('pty:env', () => {
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

  api.handle('pty:primaryRead', () => {
    try {
      return clipboard.readText('selection');
    } catch {
      return '';
    }
  });
  api.handle('pty:primaryWrite', (text) => {
    try {
      clipboard.writeText(String(text ?? ''), 'selection');
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
module.exports.__test = { helperCommand, loginShell };
