// Ctrl+Alt+Delete security screen and the Alt+F4 "Shut Down Aurora" dialog (Alt+F4 on the desktop).
//   shell.on('security:open')      fullscreen blurred overlay: Lock, Switch user, Sign out,
//                                  Change a password, Task Manager, Cancel; network / accessibility /
//                                  power buttons bottom-right.
//   shell.on('shutdown:dialog')    Windows-style dialog with a dropdown (Switch user, Sign out, Sleep,
//                                  Shut down, Restart) and a description of the selected action.
// Sign out / Shut down / Restart close every window first (apps may veto, e.g. unsaved documents).
import { api } from '../api.js';
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
      taskManager: 'Task Manager',
      cancel: 'Cancel',
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
      shutdownTitle: 'Shut Down Aurora',
      shutdownQuestion: 'What do you want the computer to do?',
      d_switchUser: 'Locks the PC so another person can sign in. Your apps stay open.',
      d_signOut: 'Closes all apps and signs you out.',
      d_sleep: "The PC stays on but uses low power. Apps stay open so when the PC wakes up, you're instantly back to where you left off.",
      d_shutdown: 'Closes all apps and turns off the PC.',
      d_restart: 'Closes all apps, turns off the PC, and then turns it on again.',
    },
  },
  fr: {
    security: {
      lock: 'Verrouiller',
      switchUser: "Changer d'utilisateur",
      signOut: 'Se déconnecter',
      changePassword: 'Modifier un mot de passe',
      taskManager: 'Gestionnaire des tâches',
      cancel: 'Annuler',
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
      shutdownTitle: 'Arrêter Aurora',
      shutdownQuestion: "Que voulez-vous que l'ordinateur fasse ?",
      d_switchUser: "Verrouille le PC pour qu'une autre personne puisse se connecter. Vos applications restent ouvertes.",
      d_signOut: 'Ferme toutes les applications et vous déconnecte.',
      d_sleep: 'Le PC reste allumé mais consomme peu. Les applications restent ouvertes : à la sortie de veille, vous reprenez là où vous en étiez.',
      d_shutdown: 'Ferme toutes les applications et éteint le PC.',
      d_restart: 'Ferme toutes les applications, éteint le PC, puis le rallume.',
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

// The wallpaper, blurred and darkened once on a small canvas (no live CSS blur: cheap in a VM).
let blurCache = { src: '', url: '' };
async function blurredWallpaper() {
  const src = theme.wallpaperUrl;
  if (!src) return '';
  if (blurCache.src === src) return blurCache.url;
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const w = 640;
    const hgt = Math.round((w * window.innerHeight) / Math.max(1, window.innerWidth));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = hgt;
    const g = c.getContext('2d');
    const k = Math.max(w / img.naturalWidth, hgt / img.naturalHeight) * 1.08;
    g.filter = 'blur(16px) saturate(1.25) brightness(0.78)';
    g.drawImage(img, (w - img.naturalWidth * k) / 2, (hgt - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
    const url = await new Promise((res) => c.toBlob((b) => res(b ? URL.createObjectURL(b) : ''), 'image/jpeg', 0.9));
    if (blurCache.url) URL.revokeObjectURL(blurCache.url);
    blurCache = { src, url };
    return url;
  } catch {
    return '';
  }
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

function closeScreen(then) {
  if (!screen) return then?.();
  const s = screen;
  screen = null;
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
  const go = (fn) => () => closeScreen(fn);
  const opts = [
    { key: 'lock', icon: 'lock_closed', action: go(() => shell.lock()) },
    { key: 'switchUser', icon: 'person_swap', action: go(() => shell.lock()) },
    { key: 'signOut', icon: 'sign_out', action: go(() => powerAction('signOut')) },
    { key: 'changePassword', icon: 'password', hidden: !registry.get('settings'), action: go(() => shell.launch('settings', { page: 'accounts', section: 'password' })) },
    { key: 'taskManager', icon: 'task_list_ltr', hidden: !registry.get('taskmgr'), action: go(() => shell.launch('taskmgr')) },
  ].filter((o) => !o.hidden);
  const buttons = opts.map((o) => h('button', { class: 'sec-opt', dataset: { key: o.key }, onclick: o.action }, t(`security.${o.key}`)));
  const cancel = h('button', { class: 'sec-cancel', onclick: () => closeScreen() }, t('security.cancel'));
  const netBtn = h('button', { class: 'sec-tray-btn', hidden: true, 'aria-label': t('security.network'), 'data-tip': t('security.network') }, icon('wifi_1', { size: 20 }));
  const a11yBtn = h('button', { class: 'sec-tray-btn', 'aria-label': t('security.accessibility'), 'data-tip': t('security.accessibility') }, icon('accessibility', { size: 20 }));
  const powerBtn = h('button', { class: 'sec-tray-btn', 'aria-label': t('security.power'), 'data-tip': t('security.power') }, icon('power', { size: 20 }));
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
  const bg = h('div', { class: 'sec-bg' });
  const blurred = await blurredWallpaper();
  if (screen) return;
  if (blurred) bg.style.setProperty('--sec-image', `url("${blurred}")`);
  const el = h(
    'div',
    { class: 'sec-screen wm-keep-focus', role: 'dialog', 'aria-modal': 'true', tabindex: '-1' },
    bg,
    h('div', { class: 'sec-center' }, h('div', { class: 'sec-list', role: 'menu' }, buttons), cancel),
    h('div', { class: 'sec-tray' }, netBtn, a11yBtn, powerBtn),
  );
  const focusables = () => [...buttons, cancel];
  const onKey = (e) => {
    if (!screen) return;
    if (document.querySelector('body > .menu')) return; // a tray menu handles its own keys
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeScreen();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = focusables();
      const i = list.indexOf(document.activeElement);
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
    }
  };
  screen = { el, onKey, prevWin: wm.focused() };
  document.addEventListener('keydown', onKey, true);
  document.getElementById('overlays').appendChild(el);
  setTimeout(() => buttons[0]?.focus(), 40);
  try {
    netState = await api.invoke('net:status');
    netBtn.replaceChildren(icon(netIcon(netState), { size: 20 }));
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
  ctx.security = {
    open: openSecurity,
    close: () => closeScreen(),
    shutdownDialog: openShutdownDialog,
    get isOpen() {
      return !!screen;
    },
  };
}
