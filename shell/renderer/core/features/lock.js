// Lock screen of the desktop session (Windows 11 style; same visuals as the sign-in screen, core/greeter/).
//   shell.on('lock')  <- Super+L, Start > Lock, Ctrl+Alt+Del > Lock, auto-lock after settings.lockTimeout
//                        minutes without input, and before the machine sleeps (auth:suspend).
// While locked, every other shell layer is `inert` (no pointer/keyboard input reaches windows or webviews),
// the screen shows the clock + notification counts, then the password box. The password is checked by the
// backend (auth:verify, main/ipc/auth.js — PAM through aurora-checkpass; rate-limited). On success:
// shell.emit('unlock') and the screen fades out. "Switch user" signs out (one session per seat).
// The main process keeps the locked state (auth:setLocked) so a shell restarted after a crash comes back locked:
// mount() locks again at once, behind the black cover features/welcome.js early() put up before the desktop mounted.
//   window.__aurora.lockScreen = { lock(), locked, el }
import { LockScreen } from '../greeter/lockui.js';
import { extendStrings } from '../greeter/strings.js';
import { accentVars, resolveWallpaper } from '../theme.js';

const LAYERS = ['desktop', 'windows', 'taskbar', 'start', 'flyouts', 'toasts'];
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'];

function codeOf(err) {
  if (err?.code) return err.code;
  const m = String(err?.message || '');
  if (/^Too many attempts/i.test(m)) return 'ERATE';
  if (/^No handler for/i.test(m)) return 'ENOHANDLER';
  return '';
}

export async function mount(ctx) {
  const { api, env, shell, settings, theme, ui, i18n, notifications, wm, sounds } = ctx;
  extendStrings(i18n);
  ui.loadCss('app://shell/core/greeter/greeter.css');

  let ls = null;
  let inerted = [];
  let prevWin = null;
  let overlayObserver = null;
  let user = { name: env.user, fullName: env.user, avatarUrl: null };
  let status = { needsPassword: !env.live, retryAfter: 0, locked: false };
  const appsOpen = () => {
    try {
      return wm.list().length > 0;
    } catch {
      return true;
    }
  };
  const setLocked = (on) => api.invoke('auth:setLocked', on).catch(() => {});
  let lastActivity = Date.now();

  const refreshStatus = async () => {
    try {
      status = { ...status, ...(await api.invoke('auth:status')) };
    } catch {}
    return status;
  };

  async function loadUser() {
    let info = null;
    try {
      info = await api.invoke('users:current');
    } catch {}
    if (!info) {
      try {
        const si = await api.invoke('sys:info');
        info = { name: si.user, fullName: si.fullName };
      } catch {}
    }
    info = info || { name: env.user };
    let picture = info.picture || info.avatar || null;
    const home = shell.xdg?.home || env.home;
    if (!picture && home) {
      for (const f of [`${home}/.face`, `${home}/.face.icon`, `${home}/.config/aurora/avatar.png`]) {
        if (await api.invoke('fs:exists', f).catch(() => false)) {
          picture = f;
          break;
        }
      }
    }
    const avatarUrl = picture ? (/^(app|media|data|blob|https?):/.test(picture) ? picture : api.mediaUrl(picture)) : null;
    user = { name: info.name || env.user, fullName: info.fullName || info.name || env.user, avatarUrl };
  }

  function badges() {
    try {
      return notifications
        .groups()
        .map((g) => ({ icon: g.icon || 'alert', label: g.appName, count: g.items.filter((n) => !n.read).length }))
        .filter((b) => b.count > 0);
    } catch {
      return [];
    }
  }

  async function onAuth(_user, password) {
    try {
      const ok = await api.invoke('auth:verify', password);
      if (ok) return { ok: true };
      const st = await refreshStatus();
      return { error: 'auth', retryAfter: st.retryAfter || 0 };
    } catch (err) {
      const code = codeOf(err);
      if (code === 'ERATE') {
        const st = await refreshStatus();
        return { error: 'rate', retryAfter: st.retryAfter || 30000 };
      }
      if (code === 'EBUSY') return { error: 'other', message: '' };
      console.warn('[lock] password check failed:', err.message);
      return { error: 'other', message: '' };
    }
  }

  function lock() {
    if (ls) return;
    ui.closeMenus?.();
    shell.emit('flyouts:close');
    prevWin = wm.focused?.() || null;
    // Nothing below the lock screen can take input (windows, webviews, taskbar, flyouts…).
    inerted = [];
    for (const id of LAYERS) {
      const el = document.getElementById(id);
      if (el && !el.inert) {
        el.inert = true;
        inerted.push(el);
      }
    }
    try {
      document.activeElement?.blur?.();
    } catch {}
    document.body.classList.add('aurora-locked');
    // Dialogs or overlays that open while locked stay behind the lock screen and cannot take input.
    const overlays = document.getElementById('overlays');
    for (const el of overlays ? [...overlays.children] : []) {
      if (!el.inert) {
        el.inert = true;
        inerted.push(el);
      }
    }
    if (overlays && 'MutationObserver' in window) {
      overlayObserver = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && n !== ls?.el && !n.inert) {
              n.inert = true;
              inerted.push(n);
            }
          }
        }
      });
      overlayObserver.observe(overlays, { childList: true });
    }
    document.addEventListener('focusin', focusGuard, true);

    const lockWall = settings.get('lockWallpaper');
    const wallpaper = lockWall ? resolveWallpaper(lockWall, theme.mode) : theme.wallpaperUrl || resolveWallpaper(settings.get('wallpaper'), theme.mode);
    ls = new LockScreen({
      mode: 'lock',
      users: [{ ...user, passwordless: !status.needsPassword }],
      selected: user.name,
      wallpaper,
      clock24h: () => settings.get('clock24h') ?? null,
      onAuth,
      onSuccess: () => unlock(),
      onPower: (action) => (action === 'sleep' ? shell.suspend() : action === 'shutdown' ? shell.shutdown() : shell.reboot()),
      // "Apps are still open": only when they are.
      confirmPower: appsOpen,
      confirmSwitch: appsOpen,
      onSwitchUser: async () => {
        try {
          await shell.logout();
        } catch (err) {
          console.warn('[lock] sign out failed:', err.message);
        }
      },
      accessibility: [
        {
          label: () => i18n.t('lockui.animations'),
          checked: () => settings.get('animations') !== false,
          toggle: () => settings.set('animations', settings.get('animations') === false),
        },
        {
          label: () => i18n.t('lockui.transparency'),
          checked: () => settings.get('transparency') !== false,
          toggle: () => settings.set('transparency', settings.get('transparency') === false),
        },
      ],
    });
    for (const [k, v] of Object.entries(accentVars(settings.get('accent'), 'dark'))) ls.el.style.setProperty(k, v);
    (document.getElementById('overlays') || document.body).appendChild(ls.el);
    ls.setBadges(badges());
    // A shell restarted while locked has a black cover up (features/welcome.js): no fade-in through which the
    // desktop would show, then the cover is no longer needed.
    const cover = document.getElementById('aurora-lock-cover');
    ls.show({ animate: !cover });
    cover?.remove();
    // Remembered by the main process (crash restarts come back locked); also pulls the keyboard focus out of web pages.
    setLocked(true);
    const cur = ls;
    if (status.retryAfter > 0) cur.setRetry(status.retryAfter);
    refreshStatus().then((st) => {
      if (ls === cur && st.retryAfter > 0) cur.setRetry(st.retryAfter);
    });
    api
      .invoke('net:status')
      .then((st) => ls === cur && cur.setNetwork(st))
      .catch(() => {});
    api
      .invoke('power:battery')
      .then((b) => ls === cur && cur.setBattery(b))
      .catch(() => {});
  }

  // Keyboard focus never leaves the lock screen (its tray menus excepted).
  function focusGuard(e) {
    if (!ls) return;
    const t = e.target;
    if (t === ls.el || ls.el.contains(t) || t.closest?.('.menu')) return;
    try {
      t.blur?.();
    } catch {}
    setTimeout(() => ls?.focus(), 0);
  }

  // Remove the lock screen and give input back to the desktop.
  function release() {
    if (!ls) return;
    const el = ls;
    ls = null;
    overlayObserver?.disconnect();
    overlayObserver = null;
    document.removeEventListener('focusin', focusGuard, true);
    for (const n of inerted) n.inert = false;
    inerted = [];
    document.body.classList.remove('aurora-locked');
    lastActivity = Date.now();
    setLocked(false);
    el.dismiss();
    const w = prevWin && wm.get?.(prevWin.id) ? prevWin : wm.focused?.();
    prevWin = null;
    setTimeout(() => {
      if (!ls && w && wm.focused?.() === w) w.focusContent?.();
    }, 420);
  }

  let emitting = false;
  function unlock() {
    if (!ls) return;
    release();
    emitting = true;
    try {
      shell.emit('unlock');
    } finally {
      emitting = false;
    }
    sounds?.play?.('unlock');
  }

  shell.on('lock', () => lock());
  // 'unlock' from elsewhere in the shell (tests stub the lock screen this way): honour it. Code running in the
  // shell page can do anything anyway; the lock screen protects against the person at the keyboard.
  shell.on('unlock', () => {
    if (!emitting) release();
  });
  api.on('auth:suspend', () => {
    if (status.needsPassword) shell.lock();
  });
  api.on('net:changed', (st) => ls?.setNetwork(st));
  notifications.on?.('change', () => ls?.setBadges(badges()));
  i18n.on('change', () => ls?.refresh());

  // ---- automatic lock after settings.lockTimeout minutes without input
  const bump = () => (lastActivity = Date.now());
  for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, bump, { capture: true, passive: true });
  api.on('shell:hotkey', bump); // keys typed in webviews (browser tabs) count too
  let idleTimer = 0;
  const mediaPlaying = () => [...document.querySelectorAll('video, audio')].some((m) => !m.paused && !m.ended && !m.muted);
  function scheduleIdle() {
    clearInterval(idleTimer);
    const minutes = Number(settings.get('lockTimeout')) || 0;
    if (minutes <= 0) return;
    const limit = minutes * 60;
    idleTimer = setInterval(
      async () => {
        if (ls) return;
        if (mediaPlaying()) bump();
        const local = (Date.now() - lastActivity) / 1000;
        if (local < limit) return;
        // System-wide idle time (X input in every window and webview); the shell page's own activity wins
        // when it is more recent.
        let system = Infinity;
        try {
          system = Number(await api.invoke('auth:idle'));
        } catch {}
        if (Math.min(local, Number.isFinite(system) ? system : Infinity) >= limit && !ls) shell.lock();
      },
      Math.max(1000, Math.min(15000, (limit * 1000) / 4)),
    );
  }
  scheduleIdle();
  settings.on('lockTimeout', scheduleIdle);

  api.on('users:changed', () => loadUser().catch(() => {}));

  ctx.lockScreen = {
    lock: () => shell.lock(),
    get locked() {
      return !!ls;
    },
    get el() {
      return ls?.el || null;
    },
  };

  // A shell restarted while the session was locked (after a crash) locks again before the desktop is usable
  // (the boot sequence waits for this mount). The account name is waited for briefly so the screen shows it.
  const userReady = loadUser().catch(() => {});
  const st = await refreshStatus();
  if (st.locked) {
    await Promise.race([userReady, new Promise((r) => setTimeout(r, 1500))]);
    shell.lock();
  } else document.getElementById('aurora-lock-cover')?.remove();
}
