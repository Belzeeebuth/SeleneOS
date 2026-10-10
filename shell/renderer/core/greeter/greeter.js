// Sign-in screen entry point (greeter.html, Electron --mode=greeter, started by greetd through
// /usr/lib/aurora/aurora-greeter). Loads only what the sign-in screen needs — no window manager,
// taskbar, desktop or apps. Backend: main/ipc/greetd.js (greeter:* channels).
//
// Flow: lock-screen picture with the clock -> any key/click -> sign-in view (account picture, password)
// -> greeter:login -> "Welcome" -> the main process quits and greetd starts /usr/bin/aurora-session.
import { api, env } from '../api.js';
import { i18n, t, LANGS } from '../i18n.js';
import { loadIcons } from '../icons.js';
import { settings } from '../settings.js';
import { accentVars, resolveWallpaper, applyVisualStyle } from '../theme.js';
import { LockScreen } from './lockui.js';
import { extendStrings } from './strings.js';
import { preload } from './backdrop.js';

const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

function mapLoginError(err) {
  const message = String(err?.message || '');
  const code = err?.code || (/^Authentication failed$/i.test(message) ? 'EAUTH' : '');
  // PAM's own text (e.g. "Account locked") is shown as a detail line; the generic one adds nothing.
  if (code === 'EAUTH') return { error: 'auth', detail: /^Authentication (failed|failure)$/i.test(message) ? '' : message };
  // A user name the system cannot have ("Other user" form): same answer as a wrong password.
  if (code === 'EINVAL' && /user name/i.test(message)) return { error: 'auth', detail: '' };
  if (code === 'EEXPIRED') return { error: 'expired', detail: message };
  return { error: 'other', message };
}

async function main() {
  extendStrings(i18n);
  const [info, a11yPrefs] = await Promise.all([
    api.invoke('greeter:info').catch(() => ({})),
    // Accessibility choices made on this screen before (larger text, animations); also sets the zoom factor.
    api.invoke('greeter:a11y').catch(() => null),
    settings.load().catch(() => ({})),
    loadIcons(),
  ]);
  i18n.init(info.lastLang || settings.get('lang') || env.lang);
  await i18n.load();

  // The sign-in screen is always dark (like Windows), with the system accent colour.
  const root = document.documentElement;
  root.dataset.theme = 'dark';
  root.dataset.transparency = settings.get('transparency') === false ? 'off' : 'on';
  root.dataset.animations = settings.get('animations') === false || a11yPrefs?.animations === false ? 'off' : 'on';
  for (const [k, v] of Object.entries(accentVars(settings.get('accent'), 'dark'))) root.style.setProperty(k, v);
  // visual style (data-style + core/styles/*.css: shapes and controls of the sign-in form), docs/PERSONALIZATION.md
  await applyVisualStyle(settings.all()).catch((err) => console.warn('[greeter] visual style:', err.message));

  const wallpaper = resolveWallpaper(settings.get('lockWallpaper') || settings.get('wallpaper') || 'builtin:bloom', 'dark');
  const [rawUsers, kbInfo] = await Promise.all([
    api.invoke('greeter:users').catch((err) => {
      console.warn('[greeter] users unavailable:', err.message);
      return [];
    }),
    api.invoke('greeter:keyboard').catch(() => null),
    withTimeout(preload(wallpaper), 1500, false),
  ]);
  const users = rawUsers.map((u) => ({
    name: u.name,
    fullName: u.fullName || u.name,
    avatarUrl: u.avatar || null,
    passwordless: !!u.passwordless,
    live: !!u.live,
  }));
  const selected = (rawUsers.find((u) => u.last) || rawUsers[0])?.name;
  const kb = { id: kbInfo?.id || 'us', layouts: kbInfo?.layouts || [] };
  let langChosen = !!info.lastLang;
  let largeText = !!a11yPrefs?.largeText;
  const saveA11y = (patch) => api.invoke('greeter:setA11y', patch).catch((err) => console.warn('[greeter] accessibility:', err.message));

  const ls = new LockScreen({
    mode: 'greeter',
    users,
    selected,
    wallpaper,
    clock24h: () => settings.get('clock24h') ?? null,
    async onAuth(user, password) {
      try {
        await api.invoke('greeter:login', user.name, password, { lang: langChosen ? i18n.lang : null });
        return { ok: true };
      } catch (err) {
        return mapLoginError(err);
      }
    },
    // Stay on "Welcome": the main process quits as soon as greetd accepted the session.
    onSuccess() {
      document.body.classList.add('signed-in');
    },
    onPower: (action) => api.invoke('greeter:power', action),
    input: {
      langs: LANGS.map((l) => ({ id: l.id, label: l.native })),
      lang: () => i18n.lang,
      onLang(id) {
        langChosen = true;
        i18n.setLang(id);
      },
      layouts: kb.layouts.map((l) => ({ id: l.id })),
      layout: () => kb.id,
      async onLayout(id) {
        try {
          const r = await api.invoke('greeter:setKeyboard', id);
          kb.id = r?.id || id;
          ls.refresh();
        } catch (err) {
          console.warn('[greeter] keyboard layout:', err.message);
        }
      },
    },
    accessibility: [
      {
        label: () => t('lockui.largerText'),
        checked: () => largeText,
        toggle() {
          largeText = !largeText;
          saveA11y({ largeText });
        },
      },
      {
        label: () => t('lockui.animations'),
        checked: () => root.dataset.animations !== 'off',
        toggle() {
          root.dataset.animations = root.dataset.animations === 'off' ? 'on' : 'off';
          saveA11y({ animations: root.dataset.animations === 'on' });
        },
      },
    ],
  });
  i18n.on('change', () => ls.refresh());
  document.getElementById('greeter').append(ls.el);
  ls.show();

  // Network and battery state (optional backends: hidden when missing).
  api
    .invoke('net:status')
    .then((st) => ls.setNetwork(st))
    .catch(() => ls.setNetwork(null));
  api.on('net:changed', (st) => ls.setNetwork(st));
  const battery = () =>
    api
      .invoke('power:battery')
      .then((b) => ls.setBattery(b))
      .catch(() => ls.setBattery(null));
  battery();
  setInterval(battery, 60000);

  window.__greeter = { ls, users, info, kb, i18n };
  document.body.classList.add('ready');
}

main().catch((err) => {
  console.error('[greeter] fatal', err);
  const pre = document.createElement('pre');
  pre.style.cssText = 'color:#fff;padding:24px;white-space:pre-wrap;font:14px monospace';
  pre.textContent = `Aurora sign-in screen failed to start:\n${err?.stack || err}`;
  document.body.replaceChildren(pre);
});
