'use strict';
// Helpers for running system commands from main-process modules.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PATH_DIRS = (process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
  .split(':')
  .concat(['/usr/sbin', '/sbin']);

function which(cmd) {
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : null;
  for (const d of PATH_DIRS) {
    const p = path.join(d, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

// run('nmcli', ['-t', 'dev']) -> { code, stdout, stderr }. Never throws on non-zero exit
// unless opts.check is true. Throws ENOENT-coded error if the binary is missing.
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const bin = which(cmd);
    if (!bin) {
      const e = new Error(`${cmd}: command not found`);
      e.code = 'ENOENT';
      e.quiet = true;
      return reject(e);
    }
    const child = execFile(
      bin,
      args,
      { timeout: opts.timeout ?? 20000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', ...(opts.env || {}) }, cwd: opts.cwd },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        const res = { code, stdout: String(stdout), stderr: String(stderr) };
        if (opts.check && code !== 0) {
          const e = new Error((res.stderr || res.stdout || `${cmd} failed`).trim());
          e.code = 'ECMD';
          e.result = res;
          return reject(e);
        }
        resolve(res);
      },
    );
    if (opts.input != null) {
      child.stdin.end(opts.input);
    }
  });
}

// Run a privileged helper action through sudo, feeding the user's password on stdin.
//   sudoRun(password, '/usr/lib/aurora/helpers/aurora-admin', ['set-hostname', 'pc'])
// Rejects with code 'EAUTH' when the password is wrong / user not allowed.
function sudoRun(password, helper, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const bin = which('sudo');
    if (!bin) {
      const e = new Error('sudo is not available');
      e.code = 'ENOENT';
      return reject(e);
    }
    const child = spawn(bin, ['-S', '-k', '-p', '', '--', helper, ...args], {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
      opts.onStdout?.(String(d));
    });
    child.stderr.on('data', (d) => {
      err += d;
      opts.onStderr?.(String(d));
    });
    child.stdin.end(`${password ?? ''}\n`);
    const timer = opts.timeout ? setTimeout(() => child.kill('SIGTERM'), opts.timeout) : null;
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) return resolve({ code, stdout: out, stderr: err });
      const authFail = /incorrect password|Sorry, try again|no password was provided|a password is required|not in the sudoers|may not run sudo/i.test(err);
      const e = new Error(authFail ? 'Authentication failed' : (err || out || `exit ${code}`).trim());
      e.code = authFail ? 'EAUTH' : 'ECMD';
      e.result = { code, stdout: out, stderr: err };
      reject(e);
    });
  });
}

// Location of privileged helpers; in dev they live in the repo's rootfs overlay.
function helperPath(name) {
  const sys = path.join('/usr/lib/aurora/helpers', name);
  if (fs.existsSync(sys)) return sys;
  const dev = path.join(__dirname, '..', '..', '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', name);
  return dev;
}

module.exports = { run, which, sudoRun, helperPath };
