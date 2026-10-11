// Ctrl+Alt+Delete security screen and the Alt+F4 "Shut Down Selene" dialog (Alt+F4 on the desktop).
//   shell.on('security:open')      a centred card on the dimmed wallpaper: the user's avatar and name,
//                                  icon tiles (Lock, Switch user, Sign out, Change a password, System
//                                  Monitor), and a footer with network / accessibility / power and Cancel.
//   shell.on('shutdown:dialog')    Windows-style dialog with a dropdown (Switch user, Sign out, Sleep,
//                                  Shut down, Restart) and a description of the selected action.
// Sign out / Shut down / Restart close every window first (apps may veto, e.g. unsaved documents).
import { api, env } from '../api.js';
import { h, icon, ui } from '../ui.js';
import { i18n, t } from '../i18n.js';
import { wm } from '../wm.js';
import { registry } from '../registry.js';
import { shell } from '../services.js';
import { settings } from '../settings.js';
import { theme } from '../theme.js';

i18n.extend({
  en: {
    security: {
      lock: 'Lock',
      switchUser: 'Switch user',
      signOut: 'Sign out',
      changePassword: 'Change a password',
      taskManager: 'System Monitor',
      cancel: 'Cancel',
      question: 'What would you like to do?',
      network: 'Network',
      accessibility: 'Accessibility',
      power: 'Power',
      connected: 'Connected to {name}',
      connectedWired: 'Connected (Ethernet)',
      noInternet: 'No internet access',
      limited: '{name} — limited connectivity',
      networkSettings: 'Network & internet settings',
      animations: 'Animation effects',
      transparency: 'Transparency effects',
      accessibilitySettings: 'Accessibility settings',
      shutdownTitle: 'Shut down Selene',
      shutdownQuestion: 'What would you like to do?',
      d_switchUser: 'Locks the computer so another person can sign in. Your apps stay open.',
      d_signOut: 'Closes all apps and signs you out.',
      d_sleep: 'The computer stays on and uses little power. Your apps stay open, so you can pick up where you left off.',
      d_shutdown: 'Closes all apps and turns off the computer.',
      d_restart: 'Closes all apps, turns off the computer, then turns it on again.',
    },
  },
  fr: {
    security: {
      lock: 'Verrouiller',
      switchUser: "Changer d'utilisateur",
      signOut: 'Se déconnecter',
      changePassword: 'Modifier un mot de passe',
      taskManager: 'Moniteur système',
      cancel: 'Annuler',
      question: 'Que souhaitez-vous faire ?',
      network: 'Réseau',
      accessibility: 'Accessibilité',
      power: 'Marche/Arrêt',
      connected: 'Connecté à {name}',
      connectedWired: 'Connecté (Ethernet)',
      noInternet: "Pas d'accès à Internet",
      limited: '{name} — connectivité limitée',
      networkSettings: 'Paramètres réseau et Internet',
      animations: "Effets d'animation",
      transparency: 'Effets de transparence',
      accessibilitySettings: "Paramètres d'accessibilité",
      shutdownTitle: 'Arrêter Selene',
      shutdownQuestion: 'Que souhaitez-vous faire ?',
      d_switchUser: "Verrouille l'ordinateur pour qu'une autre personne puisse se connecter. Vos applications restent ouvertes.",
      d_signOut: 'Ferme toutes les applications et vous déconnecte.',
      d_sleep: "L'ordinateur reste allumé et consomme peu. Vos applications restent ouvertes et vous reprenez là où vous en étiez.",
      d_shutdown: "Ferme toutes les applications et éteint l'ordinateur.",
      d_restart: "Ferme toutes les applications, éteint l'ordinateur, puis le rallume.",
    },
  },
});

// Close every window (apps may veto through onBeforeClose). Resolves true when all are gone.
export async function closeAllWindows() {
  for (const w of wm.stack()) {
    if (w._closing) continue;
    const ok = await w.close();
    if (!ok) {
      w.focus();
      return false;
    }
  }
  return true;
}

export async function powerAction(kind) {
  if (kind === 'lock' || kind === 'switchUser') return shell.lock();
  if (kind === 'sleep') return shell.suspend().catch((e) => console.warn('[power]', e.message));
  if (!(await closeAllWindows())) return;
  if (kind === 'signOut') return shell.logout();
  if (kind === 'shutdown') return shell.shutdown().catch((e) => ui.alert(e.message));
  if (kind === 'restart') return shell.reboot().catch((e) => ui.alert(e.message));
}

// ------------------------------------------------------------------ security screen
let screen = null;
const COLS = 3; // tiles per row on the card

// The signed-in user (name and picture), read once and cached for the card's header.
let userCache = null;
async function loadUser() {
  if (userCache) return userCache;
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
  const url = picture ? (/^(app|media|data|blob|https?):/.test(picture) ? picture : api.mediaUrl(picture)) : null;
  userCache = { name: info.fullName || info.name || env.user || '', url };
  return userCache;
}
const initials = (name) =>
  String(name || '?')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';
function avatarEl(u) {
  const fallback = () => h('span', { class: 'sec-avatar', 'aria-hidden': 'true' }, initials(u.name));
  if (!u.url) return fallback();
  return h('img', { class: 'sec-avatar', src: u.url, alt: '', draggable: false, onerror: (e) => e.target.replaceWith(fallback()) });
}

function netIcon(st) {
  if (!st) return 'wifi_off';
  if (st.airplane) return 'airplane';
  const p = st.primary || {};
  if (p.type === 'ethernet') return st.connectivity === 'none' ? 'plug_disconnected' : 'plug_connected';
  if (p.type === 'wifi') {
    const s = Number(p.strength) || 0;
    return st.connectivity === 'limited' ? 'wifi_warning' : s > 75 ? 'wifi_1' : s > 50 ? 'wifi_2' : s > 25 ? 'wifi_3' : 'wifi_4';
  }
  return 'globe_off';
}

function netLabel(st) {
  const p = st?.primary || {};
  if (!st || st.connectivity === 'none' || !p.type) return t('security.noInternet');
  if (st.connectivity === 'limited') return t('security.limited', { name: p.name || t('security.network') });
  if (p.type === 'ethernet') return t('security.connectedWired');
  return t('security.connected', { name: p.name || 'Wi-Fi' });
}

// While the screen is up nothing else can take input (Tab must not walk into the windows behind it).
const LAYERS = ['desktop', 'windows', 'taskbar', 'start', 'flyouts', 'toasts'];
function isolate(keep) {
  const done = [];
  const els = [...LAYERS.map((id) => document.getElementById(id)), ...(document.getElementById('overlays')?.children || [])];
  for (const el of els) {
    if (!el || el === keep || el.inert) continue;
    el.inert = true;
    done.push(el);
  }
  return () => {
    for (const el of done) el.inert = false;
  };
}

function closeScreen(then) {
  if (!screen) return then?.();
  const s = screen;
  screen = null;
  s.release?.();
  document.removeEventListener('keydown', s.onKey, true);
  s.el.classList.add('closing');
  setTimeout(() => s.el.remove(), 220);
  const prev = s.prevWin;
  if (then) then();
  else if (prev && wm.get(prev.id) && wm.focused() === prev) prev.focusContent();
}

let opening = false;
export async function openSecurity() {
  if (screen || opening) return;
  opening = true;
  try {
    await buildSecurity();
  } finally {
    opening = false;
  }
}

async function buildSecurity() {
  ui.closeMenus();
  wm.endKeyboardMove?.(false);
  const go = (fn) => () => closeScreen(fn);
  const opts = [
    { key: 'lock', icon: 'lock-simple', action: go(() => shell.lock()) },
    { key: 'switchUser', icon: 'user-switch', action: go(() => shell.lock()) },
    { key: 'signOut', icon: 'sign-out', action: go(() => powerAction('signOut')) },
    { key: 'changePassword', icon: 'password', hidden: !registry.get('settings'), action: go(() => shell.launch('settings', { page: 'accounts', section: 'password' })) },
    { key: 'taskManager', icon: 'chart-line', hidden: !registry.get('taskmgr'), action: go(() => shell.launch('taskmgr')) },
  ].filter((o) => !o.hidden);
  // Icon tiles: the label is the button's only text (tests and screen readers read it as is).
  const buttons = opts.map((o) =>
    h('button', { class: 'sec-opt', role: 'menuitem', dataset: { key: o.key }, onclick: o.action }, h('span', { class: 'sec-opt-ic', 'aria-hidden': 'true' }, icon(o.icon, { size: 22 })), h('span', { class: 'sec-opt-label' }, t(`security.${o.key}`))),
  );
  const cancel = h('button', { class: 'sec-cancel', onclick: () => closeScreen() }, t('security.cancel'));
  const netBtn = h('button', { class: 'sec-tray-btn', hidden: true, 'aria-label': t('security.network'), 'data-tip': t('security.network') }, icon('wifi-high', { size: 18 }));
  const a11yBtn = h('button', { class: 'sec-tray-btn', 'aria-label': t('security.accessibility'), 'data-tip': t('security.accessibility') }, icon('accessibility', { size: 18 }));
  const powerBtn = h('button', { class: 'sec-tray-btn', 'aria-label': t('security.power'), 'data-tip': t('security.power') }, icon('power', { size: 18 }));
  let netState = null;
  netBtn.addEventListener('click', (e) =>
    ui.menu(
      netBtn,
      [
        { header: netLabel(netState) },
        { label: t('security.networkSettings'), icon: 'settings', hidden: !registry.get('settings'), action: go(() => shell.launch('settings', { page: 'network' })) },
      ],
      { above: true },
    ),
  );
  a11yBtn.addEventListener('click', () =>
    ui.menu(
      a11yBtn,
      [
        { label: t('security.animations'), checked: settings.get('animations') !== false, action: () => settings.set('animations', settings.get('animations') === false) },
        { label: t('security.transparency'), checked: settings.get('transparency') !== false, action: () => settings.set('transparency', settings.get('transparency') === false) },
        registry.get('settings') ? '-' : null,
        { label: t('security.accessibilitySettings'), hidden: !registry.get('settings'), action: go(() => shell.launch('settings', { page: 'accessibility' })) },
      ].filter(Boolean),
      { above: true },
    ),
  );
  powerBtn.addEventListener('click', () =>
    ui.menu(
      powerBtn,
      [
        { label: t('power.sleep'), icon: 'weather_moon', action: go(() => powerAction('sleep')) },
        { label: t('power.shutdown'), icon: 'power', action: go(() => powerAction('shutdown')) },
        { label: t('power.restart'), icon: 'arrow_clockwise', action: go(() => powerAction('restart')) },
      ],
      { above: true },
    ),
  );
  // The wallpaper itself (already decoded for the desktop), dimmed by a flat scrim: no blur.
  const img = h('div', { class: 'sec-bg-img' });
  if (theme.wallpaperUrl) img.style.backgroundImage = `url("${String(theme.wallpaperUrl).replace(/"/g, '%22')}")`;
  const bg = h('div', { class: 'sec-bg' }, img);
  const who = h('div', { class: 'sec-who' }, avatarEl({ name: env.user, url: null }), h('div', { class: 'sec-who-text' }, h('div', { class: 'sec-name' }, env.user || ''), h('div', { class: 'sec-q' }, t('security.question'))));
  loadUser().then((u) => {
    if (!who.isConnected && screen?.el !== el) return;
    who.firstChild.replaceWith(avatarEl(u));
    who.querySelector('.sec-name').textContent = u.name;
  });
  const el = h(
    'div',
    {
      class: 'sec-screen wm-keep-focus kbd',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': t('security.question'),
      tabindex: '-1',
      // Opened from the keyboard: the focused option shows its focus ring until the mouse is used.
      onpointerdown: (e) => e.currentTarget.classList.remove('kbd'),
      onkeydown: (e) => e.currentTarget.classList.add('kbd'),
    },
    bg,
    h(
      'div',
      { class: 'sec-center' },
      h(
        'div',
        { class: 'sec-card' },
        who,
        h('div', { class: 'sec-list', role: 'menu', style: `--sec-cols:${COLS}` }, buttons),
        h('div', { class: 'sec-foot' }, h('div', { class: 'sec-tray' }, netBtn, a11yBtn, powerBtn), cancel),
      ),
    ),
  );
  const focusables = () => [...buttons, cancel];
  const onKey = (e) => {
    if (!screen) return;
    if (document.querySelector('body > .menu')) return; // a tray menu handles its own keys
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeScreen();
    } else if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      if (e.target.closest?.('.sec-tray')) return;
      e.preventDefault();
      const list = focusables();
      const i = list.indexOf(document.activeElement);
      const n = buttons.length;
      let j;
      if (i < 0) j = 0;
      else if (e.key === 'ArrowRight') j = (i + 1) % list.length;
      else if (e.key === 'ArrowLeft') j = (i - 1 + list.length) % list.length;
      else if (e.key === 'ArrowDown') j = i >= n ? 0 : i + COLS < n ? i + COLS : n; // last row -> Cancel
      else j = i >= n ? Math.max(0, n - 1) : i - COLS >= 0 ? i - COLS : n; // first row -> Cancel
      list[j].focus();
    }
  };
  screen = { el, onKey, prevWin: wm.focused() };
  document.addEventListener('keydown', onKey, true);
  document.getElementById('overlays').appendChild(el);
  screen.release = isolate(el);
  setTimeout(() => buttons[0]?.focus(), 40);
  try {
    netState = await api.invoke('net:status');
    netBtn.replaceChildren(icon(netIcon(netState), { size: 18 }));
    netBtn.dataset.tip = netLabel(netState);
    netBtn.hidden = false;
  } catch {
    netBtn.hidden = true; // no network backend: hide the control
  }
}

// ------------------------------------------------------------------ Alt+F4 on the desktop
let shutdownOpen = false;
export async function openShutdownDialog() {
  if (shutdownOpen) return;
  shutdownOpen = true;
  const kinds = ['switchUser', 'signOut', 'sleep', 'shutdown', 'restart'];
  const labels = { switchUser: t('power.switchUser'), signOut: t('power.signOut'), sleep: t('power.sleep'), shutdown: t('power.shutdown'), restart: t('power.restart') };
  let value = 'shutdown';
  const desc = h('div', { class: 'sd-desc' }, t('security.d_shutdown'));
  const select = ui.select({
    options: kinds.map((k) => ({ value: k, label: labels[k] })),
    value,
    onchange: (v) => {
      value = v;
      desc.textContent = t(`security.d_${v}`);
    },
  });
  select.classList.add('sd-select');
  const body = h(
    'div',
    { class: 'sd' },
    h('div', { class: 'sd-hero' }, h('img', { src: 'app://shell/assets/aurora-logo.svg', alt: '', draggable: false }), h('span', null, t('security.shutdownTitle'))),
    h('label', { class: 'sd-q' }, t('security.shutdownQuestion')),
    select,
    desc,
  );
  try {
    const res = await ui.dialog({
      title: t('security.shutdownTitle'),
      body,
      className: 'sd-dialog',
      buttons: [
        { label: t('common.ok'), value: 'ok', primary: true },
        { label: t('common.cancel'), value: null },
      ],
      onOpen: () => setTimeout(() => select.focus(), 60),
    });
    if (res === 'ok') await powerAction(value);
  } finally {
    shutdownOpen = false;
  }
}

export function mount(ctx) {
  ui.loadCss('app://shell/core/features/security.css');
  shell.on('security:open', () => openSecurity());
  shell.on('shutdown:dialog', () => openShutdownDialog());
  shell.on('lock', () => closeScreen(() => {}));
  // Read the user's name and picture while the shell is idle, so the card shows them at once.
  setTimeout(() => (window.requestIdleCallback || setTimeout)(() => loadUser(), { timeout: 4000 }), 3000);
  ctx.security = {
    open: openSecurity,
    close: () => closeScreen(),
    shutdownDialog: openShutdownDialog,
    get isOpen() {
      return !!screen;
    },
  };
}
