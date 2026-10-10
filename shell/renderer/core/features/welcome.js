// Session "Welcome": right after signing in, the shell starts behind the same "Welcome" view the sign-in
// screen ended on (blurred picture, account picture, orbiting dots), then fades into the desktop, which
// settles in with a slight zoom while the taskbar slides up. Shown once per login session (not after a
// crash restart: main/ipc/greetd.js session:welcome), about one second, skippable (click / any key),
// never with animations off. The startup sound is played by the boot sequence when the desktop is ready.
//
// early(ctx) runs from core/boot.js before the desktop mounts (so the desktop never flashes first);
// mount(ctx) is the regular feature entry and falls back to showing the overlay itself.
import { h } from '../ui.js';
import { avatar, spinner } from '../greeter/lockui.js';
import { extendStrings } from '../greeter/strings.js';
import { blurredImage } from '../greeter/backdrop.js';
import { resolveWallpaper } from '../theme.js';

const MIN_VISIBLE = 900;
const FAILSAFE = 7000;

let state = null; // { el, shownAt, done }
let decided = false;

function loadCss(href) {
  if (document.querySelector(`link[data-href="${href}"]`)) return Promise.resolve();
  return new Promise((resolve) => {
    const link = h('link', { rel: 'stylesheet', href, 'data-href': href });
    link.addEventListener('load', resolve);
    link.addEventListener('error', resolve);
    document.head.appendChild(link);
    setTimeout(resolve, 600);
  });
}

async function userInfo(api, env) {
  try {
    const u = await api.invoke('users:current');
    if (u?.name) return { name: u.name, fullName: u.fullName || u.name, picture: u.picture || u.avatar || null };
  } catch {}
  try {
    const si = await api.invoke('sys:info');
    return { name: si.user || env.user, fullName: si.fullName || si.user || env.user };
  } catch {}
  return { name: env.user, fullName: env.user };
}

/** Decide (once) and, on the first start of the session, cover the screen with the Welcome view. */
export async function early({ api, env, settings, i18n }) {
  if (decided) return !!state;
  decided = true;
  let first = false;
  let hold = 0;
  try {
    const r = await api.invoke('session:welcome');
    first = r === true || r?.show === true;
    hold = Number(r?.hold) || 0;
  } catch {}
  if (!first) {
    // A shell restarted in the same session (after a crash) must not replay the startup sound.
    if (!env.dev) {
      try {
        sessionStorage.setItem('aurora-started', '1');
      } catch {}
    }
    return false;
  }
  if (settings.get('animations') === false) return false;
  extendStrings(i18n);

  const t = i18n.t;
  const name = h('div', { class: 'lk-name' }, env.user);
  const avatarSlot = h('div', { class: 'lk-avatar-slot' }, avatar({ name: env.user, fullName: env.user }));
  const blur = h('div', { class: 'lk-blur' });
  const el = h(
    'div',
    {
      class: 'lockui lk-welcome stage-signin busy',
      role: 'status',
      'aria-label': t('lockui.welcome'),
      // Until the stylesheet arrives the overlay is a plain black cover (never a flash of the desktop).
      style: 'position:fixed;inset:0;z-index:2147483000;background:#000',
    },
    h(
      'div',
      { class: 'lk-signin' },
      blur,
      h('div', { class: 'lk-scrim' }),
      h(
        'div',
        { class: 'lk-center' },
        h('div', { class: 'lk-card' }, avatarSlot, name, h('div', { class: 'lk-form-slot' }, h('div', { class: 'lk-busy' }, spinner(), h('div', { class: 'lk-busy-text' }, t('lockui.welcome'))))),
      ),
    ),
    h('button', { type: 'button', class: 'lk-welcome-skip', 'aria-label': t('lockui.skip'), tabindex: '-1' }),
  );
  state = { el, shownAt: Date.now(), done: false, minVisible: MIN_VISIBLE + hold };
  document.body.appendChild(el);
  performance.mark('aurora:welcome-shown');
  const skip = (e) => {
    if (e.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    finish(true);
  };
  el.addEventListener('pointerdown', skip);
  window.addEventListener('keydown', skip, true);
  state.offKeys = () => window.removeEventListener('keydown', skip, true);
  state.failsafe = setTimeout(() => finish(true), FAILSAFE + hold);

  // Account name and photo: asked for right away, filled in as soon as they are known.
  userInfo(api, env).then(async (u) => {
    if (!state || state.done) return;
    name.textContent = u.fullName || u.name;
    let picture = u.picture;
    const home = env.home;
    if (!picture && home) {
      for (const f of [`${home}/.face`, `${home}/.face.icon`, `${home}/.config/aurora/avatar.png`]) {
        if (await api.invoke('fs:exists', f).catch(() => false)) {
          picture = f;
          break;
        }
      }
    }
    const avatarUrl = picture ? (/^(app|media|data|blob|https?):/.test(picture) ? picture : api.mediaUrl(picture)) : null;
    avatarSlot.replaceChildren(avatar({ name: u.name, fullName: u.fullName, avatarUrl }));
  });
  await Promise.all([loadCss('app://shell/core/greeter/greeter.css'), loadCss('app://shell/core/features/welcome.css')]);

  // Background: the desktop picture, blurred.
  const theme = settings.get('theme') === 'dark' ? 'dark' : 'light';
  const wall = resolveWallpaper(settings.get('wallpaper'), theme);
  blur.style.setProperty('background-image', `url("${wall}")`);
  blurredImage(wall, { blur: 30, brightness: 0.72, saturate: 1.3 }).then((url) => {
    if (!url) return;
    blur.style.backgroundImage = `url("${url}")`;
    blur.classList.add('ready');
  });
  return true;
}

function finish(fast = false) {
  const s = state;
  if (!s || s.done) return;
  s.done = true;
  performance.mark('aurora:welcome-finish');
  clearTimeout(s.failsafe);
  s.offKeys?.();
  const body = document.body;
  if (!fast) {
    body.classList.add('aurora-welcome-reveal');
    setTimeout(() => body.classList.remove('aurora-welcome-reveal'), 1200);
  }
  s.el.classList.add('lk-out');
  if (fast) s.el.classList.add('lk-out-fast');
  s.el.style.pointerEvents = 'none';
  setTimeout(() => s.el.remove(), fast ? 220 : 640);
  window.__aurora && (window.__aurora.welcome = { shown: true, done: true });
}

export async function mount(ctx) {
  if (!decided) await early(ctx);
  if (!state) return;
  ctx.welcome = {
    get shown() {
      return true;
    },
    get done() {
      return !!state?.done;
    },
    skip: () => finish(true),
  };
  ctx.shell.on('ready', () => {
    if (!state || state.done) return;
    const wait = Math.max(0, state.minVisible - (Date.now() - state.shownAt));
    setTimeout(() => finish(false), wait);
  });
}
