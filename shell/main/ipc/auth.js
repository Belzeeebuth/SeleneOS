'use strict';
// Lock screen authentication (shell mode only).
//
//   auth:status           -> { needsPassword, retryAfter (ms, 0 when attempts are allowed), failures, user, locked }
//   auth:verify (password) -> true | false   for the CURRENT user. Throws ERATE while attempts are rate-limited
//                            (see auth:status.retryAfter), EBUSY while a check runs, ECHECKPASS when the helper
//                            itself failed (missing, crashed, timed out: never treated as success, never counted as a
//                            wrong password).
//   auth:setLocked (bool) -> the lock screen came up / went away. The state outlives the renderer: in a real session it
//                            is kept in $XDG_RUNTIME_DIR, so a shell restarted after a crash comes back locked
//                            (auth:status.locked). Locking also takes the keyboard focus back from web pages
//                            (<webview> guests keep it in the browser process even when their element becomes inert).
//   auth:idle             -> seconds since the last keyboard/pointer input anywhere in the X session
//                            (all windows and webviews; Electron powerMonitor / XScreenSaver extension)
//   event auth:suspend    -> the machine is about to sleep (the lock screen locks first)
//
// The password is checked by /usr/lib/aurora/helpers/aurora-checkpass (python3 + libpam through ctypes, PAM
// service "aurora-lock"), which reads it on stdin and exits 0 (correct) / 1 (wrong). It runs as the user, so
// pam_unix verifies through unix_chkpwd, which only ever checks the caller's own password.
// Rate limiting: 5 free attempts, then 30 s doubling up to 5 min. An empty password (Enter pressed on an empty box,
// e.g. to wake the screen) is checked but never counted as a failed attempt.
// Live session (casper's passwordless user): unlocking needs no password.
// Dev mode (--dev): no PAM; the password is "aurora". AURORA_LOCK_STATE=<file> keeps the lock state in that file
// (tests of the crash-restart path); otherwise dev keeps it in memory only.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { helperPath } = require('../lib/exec');

/** Consecutive-failure backoff: `free` attempts, then base * 2^n ms (capped at max). */
function createLimiter({ now = () => Date.now(), free = 5, base = 30000, max = 300000 } = {}) {
  let failures = 0;
  let until = 0;
  return {
    /** ms until the next attempt is allowed (0 = now). */
    wait() {
      return Math.max(0, until - now());
    },
    fail() {
      failures++;
      if (failures >= free) until = now() + Math.min(max, base * 2 ** (failures - free));
      return this.wait();
    },
    succeed() {
      failures = 0;
      until = 0;
    },
    get failures() {
      return failures;
    },
  };
}

function checkpassError(message) {
  const e = new Error(message);
  e.code = 'ECHECKPASS';
  return e;
}

/**
 * Run the PAM helper: resolves true (exit 0) / false (exit 1); rejects with ECHECKPASS on any other outcome
 * (helper missing or not executable, usage/PAM errors, killed, timed out).
 */
function checkPassword(password, { helper = helperPath('aurora-checkpass'), args = [], timeout = 25000 } = {}) {
  // The helper reads one line: a password containing a newline (or NUL) can never be the right one, and must not be
  // cut short at the newline either.
  if (typeof password !== 'string' || /[\n\0]/.test(password)) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = execFile(
        helper,
        args,
        { timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C' } },
        (err, _stdout, stderr) => {
          if (!err) return resolve(true);
          if (typeof err.code === 'number') {
            if (err.code === 1) return resolve(false);
            return reject(checkpassError(String(stderr || '').trim() || `aurora-checkpass exited with ${err.code}`));
          }
          if (err.killed || err.signal) return reject(checkpassError(`aurora-checkpass did not finish (${err.signal || 'killed'})`));
          reject(checkpassError(`aurora-checkpass is not available: ${err.message}`));
        },
      );
    } catch (err) {
      reject(checkpassError(`aurora-checkpass is not available: ${err.message}`));
      return;
    }
    child.stdin?.on('error', () => {});
    child.stdin?.end(`${password}\n`);
  });
}

/** Where the "locked" state survives a shell restart (null: memory only). */
function lockMarker(DEV) {
  if (process.env.AURORA_LOCK_STATE) return process.env.AURORA_LOCK_STATE;
  if (DEV) return null;
  const dir = process.env.XDG_RUNTIME_DIR;
  if (!dir) return null;
  const id = String(process.env.XDG_SESSION_ID || 'session').replace(/[^\w.-]/g, '_');
  return path.join(dir, `aurora-locked-${id}`);
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

module.exports = function register(api) {
  const { env, DEV } = api;
  if (env?.mode === 'greeter') return;
  const limiter = createLimiter();
  const needsPassword = !env.live;
  let busy = false;

  const marker = lockMarker(DEV);
  let locked = false;
  try {
    locked = !!marker && fs.existsSync(marker);
  } catch {}
  const persistLocked = () => {
    if (!marker) return;
    try {
      if (locked) fs.writeFileSync(marker, String(Date.now()), { mode: 0o600 });
      else fs.rmSync(marker, { force: true });
    } catch (err) {
      console.warn(`[auth] cannot record the lock state in ${marker}: ${err.message}`);
    }
  };

  // A normal exit is the end of the session (sign out): nothing to restore. (A crash never gets here.)
  try {
    if (marker) require('electron').app.on('will-quit', () => fs.rmSync(marker, { force: true }));
  } catch {}

  api.handle('auth:status', () => ({ needsPassword, retryAfter: limiter.wait(), failures: limiter.failures, user: env.user, locked }));

  api.handle('auth:setLocked', (on) => {
    locked = on === true;
    persistLocked();
    if (locked) {
      // Keyboard focus back to the shell page: a focused web page (webview guest) would otherwise keep receiving
      // what is typed on the lock screen.
      try {
        const w = api.getMainWindow();
        if (w && !w.isDestroyed()) w.webContents.focus();
      } catch {}
    }
    return locked;
  });

  api.handle('auth:verify', async (password) => {
    if (typeof password !== 'string' || password.length > 4096) throw api.error('Invalid password', 'EINVAL');
    const wait = limiter.wait();
    if (wait > 0) {
      const e = api.error(`Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.`, 'ERATE');
      e.quiet = true;
      throw e;
    }
    if (!needsPassword) {
      limiter.succeed();
      return true;
    }
    if (busy) throw api.error('A password check is already running', 'EBUSY');
    busy = true;
    try {
      let ok;
      if (DEV) {
        await delay(450);
        ok = password === 'aurora';
      } else {
        ok = await checkPassword(password);
      }
      if (ok) limiter.succeed();
      else if (password) limiter.fail();
      return ok;
    } finally {
      busy = false;
    }
  });

  let powerMonitor = null;
  try {
    powerMonitor = require('electron').powerMonitor;
  } catch {}
  api.handle('auth:idle', () => {
    if (!powerMonitor) throw api.error('Idle time is not available', 'ENOTSUP');
    return powerMonitor.getSystemIdleTime();
  });
  try {
    powerMonitor?.on('suspend', () => api.broadcast('auth:suspend', {}));
  } catch {}
};

module.exports.createLimiter = createLimiter;
module.exports.checkPassword = checkPassword;
module.exports.lockMarker = lockMarker;
