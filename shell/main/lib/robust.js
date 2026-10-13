'use strict';
// Robustness of the shell and greeter windows (track "robust").
//   watchWindow(win, { mode, onSafeMode })
//     - 'render-process-gone' -> the renderer is reloaded (logged). The session lock state lives in the main
//       process (main/ipc/auth.js auth:setLocked), so a reloaded shell comes back LOCKED when it was locked.
//     - 'unresponsive' -> waits UNRESPONSIVE_GRACE ms for 'responsive', then kills the renderer, which reloads it.
//     - 3 renderer crashes within 2 minutes (shell mode) -> safe mode (state.safeMode), then the reload.
//     - reloads back off (0.3 s, 0.6 s, 1.2 s … up to 8 s); after GIVE_UP crashes within 2 minutes the app exits
//       with code 1, so aurora-xsession (shell) or greetd (greeter) takes over instead of a blank reload loop.
//     - renderer console errors (uncaught exceptions, unhandled rejections, console.error) reach stderr
//       (= the session journal through systemd-cat, aurora-session) as "[renderer:<app>] message (source:line)".
//   state: shared with main/ipc/robust.js and main/ipc/settings.js
//     { safeMode, safeReason, crashes, settingsRecovered, saveFailed, lowDisk, acked:{} }
// Safe mode also starts with AURORA_SAFE_MODE=1 (aurora-xsession after 2 shell crashes in a row).
const CRASH_WINDOW = 2 * 60 * 1000;
const CRASH_LIMIT = 3;
const GIVE_UP = 6;
const UNRESPONSIVE_GRACE = Number(process.env.AURORA_UNRESPONSIVE_GRACE) || 5000;

const state = {
  safeMode: process.env.AURORA_SAFE_MODE === '1',
  safeReason: process.env.AURORA_SAFE_MODE === '1' ? 'session' : null,
  crashes: 0,
  settingsRecovered: null, // 'backup' | 'defaults' (a corrupt settings.json was replaced)
  saveFailed: null, // { code, at } the last settings save failed (ENOSPC…)
  lowDisk: null, // { avail, total, path }
  acked: {},
};

function enterSafeMode(reason) {
  if (state.safeMode) return;
  state.safeMode = true;
  state.safeReason = reason;
  process.env.AURORA_SAFE_MODE = '1';
  console.error(`[robust] safe mode on (${reason})`);
}

function leaveSafeMode() {
  state.safeMode = false;
  state.safeReason = null;
  state.crashes = 0;
  delete process.env.AURORA_SAFE_MODE;
  console.error('[robust] safe mode off (restart requested by the user)');
}

/** App id of a renderer source URL (app://shell/apps/<id>/…), 'shell' otherwise. */
function appOfSource(src) {
  const m = /^app:\/\/shell\/apps\/([a-z0-9_-]+)\//i.exec(String(src || ''));
  return m ? m[1] : 'shell';
}

function watchWindow(win, { mode = 'shell' } = {}) {
  const wc = win.webContents;
  const times = [];
  const all = []; // every crash within the window (not reset by safe mode): bounds the reload loop
  let hangTimer = null;
  let logged = 0;
  let logWindow = Date.now();

  wc.on('render-process-gone', (_e, details = {}) => {
    clearTimeout(hangTimer);
    if (win.isDestroyed()) return;
    const now = Date.now();
    times.push(now);
    while (times.length && now - times[0] > CRASH_WINDOW) times.shift();
    state.crashes = times.length;
    console.error(`[robust] ${mode} renderer gone (${details.reason || '?'}, exit ${details.exitCode ?? '?'}); crash ${times.length} within 2 min; reloading`);
    if (mode === 'shell' && times.length >= CRASH_LIMIT) {
      enterSafeMode('renderer-crashes');
      times.length = 0;
    }
    all.push(now);
    while (all.length && now - all[0] > CRASH_WINDOW) all.shift();
    if (all.length >= GIVE_UP) {
      console.error(`[robust] ${mode} renderer crashed ${all.length} times within 2 min: giving up, the session takes over`);
      require('electron').app.exit(1);
      return;
    }
    const delay = Math.min(300 * 2 ** (all.length - 1), 8000);
    setTimeout(() => {
      if (!win.isDestroyed()) wc.reload();
    }, delay);
  });

  wc.on('unresponsive', () => {
    console.error(`[robust] ${mode} renderer unresponsive; waiting ${UNRESPONSIVE_GRACE} ms`);
    clearTimeout(hangTimer);
    hangTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      console.error(`[robust] ${mode} renderer still unresponsive: restarting it`);
      try {
        wc.forcefullyCrashRenderer(); // -> render-process-gone -> reload
      } catch {
        wc.reload();
      }
    }, UNRESPONSIVE_GRACE);
  });
  wc.on('responsive', () => {
    if (hangTimer) console.error(`[robust] ${mode} renderer responsive again`);
    clearTimeout(hangTimer);
    hangTimer = null;
  });

  // Electron >= 35 passes one event object ({ level, message, lineNumber, sourceId }); older ones positional args.
  wc.on('console-message', (e, lvl, msg, line, src) => {
    const level = typeof e?.level === 'string' ? e.level : lvl === 3 ? 'error' : String(lvl);
    if (level !== 'error') return;
    const message = typeof e?.message === 'string' ? e.message : msg;
    const sourceId = e?.sourceId ?? src;
    const lineNumber = e?.lineNumber ?? line;
    const now = Date.now();
    if (now - logWindow > 60000) {
      logWindow = now;
      logged = 0;
    }
    if (++logged > 60) return; // at most 60 lines a minute: a looping error must not flood the journal
    console.error(`[renderer:${appOfSource(sourceId)}] ${String(message).slice(0, 2000)} (${sourceId || '?'}:${lineNumber ?? '?'})`);
  });
}

module.exports = { state, watchWindow, enterSafeMode, leaveSafeMode, appOfSource, CRASH_LIMIT, CRASH_WINDOW, GIVE_UP };
