'use strict';
// Lock screen authentication (shell mode only).
//
//   auth:status           -> { needsPassword, retryAfter (ms, 0 when attempts are allowed), failures, user }
//   auth:verify (password) -> true | false   for the CURRENT user. Throws ERATE while attempts are rate-limited
//                            (see auth:status.retryAfter), EBUSY while a check runs, ECHECKPASS when the helper
//                            itself failed (never treated as success).
//   auth:idle             -> seconds since the last keyboard/pointer input anywhere in the X session
//                            (all windows and webviews; Electron powerMonitor / XScreenSaver extension)
//   event auth:suspend    -> the machine is about to sleep (the lock screen locks first)
//
// The password is checked by /usr/lib/aurora/helpers/aurora-checkpass (python3 + libpam through ctypes, PAM
// service "aurora-lock"), which reads it on stdin and exits 0 (correct) / 1 (wrong). It runs as the user, so
// pam_unix verifies through unix_chkpwd, which only ever checks the caller's own password.
// Live session (casper's passwordless user): unlocking needs no password.
// Dev mode (--dev): no PAM; the password is "aurora".
const { run, helperPath } = require('../lib/exec');

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

/** Run the PAM helper: resolves true/false; rejects (ECHECKPASS) on any other outcome. */
async function checkPassword(password, { helper = helperPath('aurora-checkpass'), args = [], timeout = 25000 } = {}) {
  let r;
  try {
    r = await run(helper, args, { input: `${password}\n`, timeout });
  } catch (err) {
    const e = new Error(`aurora-checkpass is not available: ${err.message}`);
    e.code = 'ECHECKPASS';
    throw e;
  }
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  const e = new Error((r.stderr || r.stdout || `aurora-checkpass exited with ${r.code}`).trim());
  e.code = 'ECHECKPASS';
  throw e;
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

module.exports = function register(api) {
  const { env, DEV } = api;
  if (env?.mode === 'greeter') return;
  const limiter = createLimiter();
  const needsPassword = !env.live;
  let busy = false;

  api.handle('auth:status', () => ({ needsPassword, retryAfter: limiter.wait(), failures: limiter.failures, user: env.user }));

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
      else limiter.fail();
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
