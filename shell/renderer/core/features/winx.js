// Menu rapide (Super+X, or right-click on the Lanceur button) and the window menu
// (right-click on a title bar, click on the window icon, or Alt+Space).
// Both menus support access keys; their underlines show only while Alt is held.
//   shell.on('winx:toggle')          shell.on('sysmenu:open', win)
//   wm.on('titlebar-menu', (win, event))
import { h, ui } from '../ui.js';
import { i18n, t } from '../i18n.js';
import { wm } from '../wm.js';
import { registry } from '../registry.js';
import { shell } from '../services.js';
import { powerAction } from './security.js';

i18n.extend({
  en: {
    winx: {
      gSystem: 'System',
      gSession: 'Session',
      gShortcuts: 'Shortcuts',
      settings: '&Settings',
      taskmgr: 'System &Monitor',
      disks: '&Disks',
      network: '&Network',
      lock: '&Lock',
      signOut: 'Sign &out',
      shutdownMenu: 'Sh&ut down or restart',
      terminal: '&Terminal',
      files: '&Files',
      search: 'S&earch',
      run: '&Run',
      desktop: 'Des&ktop',
      sleep: '&Sleep',
      shutdown: 'Shut &down',
      restart: '&Restart',
    },
    sysmenu: { restore: '&Restore', move: '&Move', size: '&Size', minimize: 'Mi&nimize', maximize: 'Ma&ximize', close: '&Close' },
  },
  fr: {
    winx: {
      gSystem: 'Système',
      gSession: 'Session',
      gShortcuts: 'Raccourcis',
      settings: '&Paramètres',
      taskmgr: '&Moniteur système',
      disks: '&Disques',
      network: '&Réseau',
      lock: '&Verrouiller',
      signOut: 'Se dé&connecter',
      shutdownMenu: 'Éteindre o&u redémarrer',
      terminal: '&Terminal',
      files: '&Fichiers',
      search: 'Rec&hercher',
      run: 'E&xécuter',
      desktop: '&Bureau',
      sleep: 'Mettre en &veille',
      shutdown: '&Éteindre',
      restart: '&Redémarrer',
    },
    sysmenu: { restore: '&Restaurer', move: '&Déplacer', size: '&Taille', minimize: 'Réd&uire', maximize: '&Agrandir', close: '&Fermer' },
  },
});

// "System &Monitor" -> <span>…<u>M</u>…</span> ; the accelerator is the letter after '&'.
function accel(key) {
  const text = t(key);
  const i = text.indexOf('&');
  if (i < 0 || i === text.length - 1) return text;
  return h('span', { class: 'accel-label' }, text.slice(0, i), h('u', null, text[i + 1]), text.slice(i + 2));
}

// Pressing an access key (alone or with Alt) activates that item in the top-most open menu.
// The underlines stay hidden and show only while Alt is held (.alt-keys on the open menus).
function showAccels(on) {
  for (const m of document.querySelectorAll('body > .menu.wm-accel-menu')) m.classList.toggle('alt-keys', on);
}
function onAltUp(e) {
  if (e.key === 'Alt') showAccels(false);
}
function onAccelKey(e) {
  if (e.key === 'Alt') {
    e.preventDefault();
    showAccels(true);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.key.length !== 1) return;
  const menus = document.querySelectorAll('body > .menu');
  const top = menus[menus.length - 1];
  if (!top) return;
  const k = e.key.toLowerCase();
  const row = [...top.querySelectorAll('.menu-item:not(.disabled)')].find((r) => r.querySelector('.label u')?.textContent.toLowerCase() === k);
  if (!row) return;
  e.preventDefault();
  e.stopPropagation();
  row.click();
}

function launch(id, args) {
  if (!registry.get(id)) return;
  shell.emit('start:close');
  shell.launch(id, args);
}

// Drop hidden items and the separators they leave behind (leading, trailing, doubled).
function tidy(items) {
  const out = [];
  for (const it of items) {
    if (!it || it.hidden) continue;
    if (it === '-' && (!out.length || out[out.length - 1] === '-')) continue;
    out.push(it.submenu ? { ...it, submenu: tidy(it.submenu) } : it);
  }
  while (out[out.length - 1] === '-') out.pop();
  // A section header with nothing under it goes too.
  return out.filter((it, i) => !it.header || (out[i + 1] && out[i + 1] !== '-' && !out[i + 1].header));
}

function onBlurAccels() {
  showAccels(false);
}

async function openAccelMenu(at, items, { prevWin, keyboard = true, above = false, place = null } = {}) {
  items = tidy(items);
  document.addEventListener('keydown', onAccelKey, true);
  document.addEventListener('keyup', onAltUp, true);
  window.addEventListener('blur', onBlurAccels);
  const p = ui.menu(at, items, { class: ['wm-accel-menu', keyboard ? 'kbd' : ''].join(' '), above });
  // Put the keyboard in the menu (it may have been inside a webview).
  const el = [...document.querySelectorAll('body > .menu')].pop();
  if (el && place) place(el); // final position, once the menu's size is known (before it is painted)
  el?.focus({ preventScroll: true });
  const res = await p;
  document.removeEventListener('keydown', onAccelKey, true);
  document.removeEventListener('keyup', onAltUp, true);
  window.removeEventListener('blur', onBlurAccels);
  if (!res && prevWin && wm.focused() === prevWin) prevWin.focusContent();
  return res;
}

// ------------------------------------------------------------------ Win+X
let winxOpen = false;

// Grouped sections (Système, Session, Raccourcis), each item with a Phosphor icon.
function winxItems() {
  const has = (id) => !!registry.get(id);
  return [
    { header: t('winx.gSystem') },
    { label: accel('winx.settings'), icon: 'gear-six', hidden: !has('settings'), action: () => launch('settings') },
    { label: accel('winx.taskmgr'), icon: 'chart-line', hidden: !has('taskmgr'), action: () => launch('taskmgr') },
    { label: accel('winx.disks'), icon: 'hard-drives', hidden: !has('files'), action: () => launch('files', { path: 'thispc' }) },
    { label: accel('winx.network'), icon: 'wifi-high', hidden: !has('settings'), action: () => launch('settings', { page: 'network' }) },
    '-',
    { header: t('winx.gSession') },
    { label: accel('winx.lock'), icon: 'lock-simple', action: () => powerAction('lock') },
    // Same path as the Ctrl+Alt+Del / Alt+F4 power options: apps get to veto (unsaved work), errors are shown.
    { label: accel('winx.signOut'), icon: 'sign-out', action: () => powerAction('signOut') },
    {
      label: accel('winx.shutdownMenu'),
      icon: 'power',
      submenu: [
        { label: accel('winx.sleep'), icon: 'moon', action: () => powerAction('sleep') },
        { label: accel('winx.shutdown'), icon: 'power', action: () => powerAction('shutdown') },
        { label: accel('winx.restart'), icon: 'arrow-clockwise', action: () => powerAction('restart') },
      ],
    },
    '-',
    { header: t('winx.gShortcuts') },
    { label: accel('winx.terminal'), icon: 'terminal-window', hidden: !has('terminal'), action: () => launch('terminal') },
    { label: accel('winx.files'), icon: 'folder-simple', hidden: !has('files'), action: () => launch('files') },
    { label: accel('winx.search'), icon: 'magnifying-glass', action: () => shell.emit('search:open', { query: '' }) },
    { label: accel('winx.run'), icon: 'play', action: () => shell.emit('run:open') },
    { label: accel('winx.desktop'), icon: 'desktop', action: () => wm.toggleDesktop() },
  ];
}

// Opened from the keyboard: centred along the bar, just off its inner edge (bar on any side of the screen).
function placeByBar(el, pos) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const m = el.getBoundingClientRect();
  const bar = document.getElementById('taskbar')?.getBoundingClientRect();
  const has = !!(bar && bar.width && bar.height);
  const gap = 8;
  let x;
  let y;
  if (pos === 'top' || pos === 'bottom') {
    x = (W - m.width) / 2;
    if (pos === 'top') y = Math.max(has ? bar.bottom : 0, wm.insets.top) + gap;
    else y = Math.min(has ? bar.top : H, H - wm.insets.bottom) - gap - m.height;
  } else {
    y = (H - m.height) / 2;
    if (pos === 'left') x = Math.max(has ? bar.right : 0, wm.insets.left) + gap;
    else x = Math.min(has ? bar.left : W, W - wm.insets.right) - gap - m.width;
  }
  el.classList.toggle('up', pos === 'bottom');
  el.style.left = `${Math.round(Math.max(4, Math.min(x, W - m.width - 4)))}px`;
  el.style.top = `${Math.round(Math.max(4, Math.min(y, H - m.height - 4)))}px`;
}

// Super+X: centred along the bar. Right-click on the Lanceur button (e = the contextmenu event): at the pointer,
// opening upwards or leftwards when there is no room below or to the right.
export async function toggleWinX(e = null) {
  if (winxOpen) {
    ui.closeMenus();
    return;
  }
  shell.emit('start:close');
  shell.emit('flyouts:close');
  const start = document.querySelector('#taskbar .tb-start');
  const pos = document.documentElement.dataset.tbPos || 'bottom';
  const pointer = e && typeof e.clientX === 'number' && (e.clientX || e.clientY);
  const at = pointer ? { x: e.clientX, y: e.clientY, anchor: new DOMRect(e.clientX, e.clientY, 0, 0), sub: new DOMRect(e.clientX, e.clientY, 0, 0) } : { x: 0, y: 0 };
  winxOpen = true;
  start?.classList.add('open');
  try {
    await openAccelMenu(at, winxItems(), { prevWin: wm.focused(), keyboard: !pointer, place: pointer ? null : (el) => placeByBar(el, pos) });
  } finally {
    winxOpen = false;
    start?.classList.remove('open');
  }
}

// ------------------------------------------------------------------ window menu
export function openSysMenu(win, e) {
  if (!win || win._closing) return;
  const o = win.opts;
  const max = win.state === 'maximized';
  const items = [
    { label: accel('sysmenu.restore'), icon: 'square_multiple', disabled: win.state === 'normal' && !win.minimized, action: () => win.restore() },
    { label: accel('sysmenu.move'), icon: null, disabled: max || win.fullscreen, action: () => setTimeout(() => win.startKeyboardMove('move'), 0) },
    { label: accel('sysmenu.size'), icon: null, disabled: max || win.fullscreen || !o.resizable, action: () => setTimeout(() => win.startKeyboardMove('size'), 0) },
    { label: accel('sysmenu.minimize'), icon: 'subtract', disabled: !o.minimizable || win.minimized, action: () => win.minimize() },
    { label: accel('sysmenu.maximize'), icon: 'square', disabled: max || !o.maximizable || !o.resizable, action: () => win.maximize() },
    '-',
    { label: accel('sysmenu.close'), icon: 'dismiss', shortcut: 'Alt+F4', action: () => win.close() },
  ];
  let at;
  const fromMouse = e && typeof e.clientX === 'number' && (e.clientX || e.clientY) && e.target !== win.iconEl;
  if (fromMouse) at = e;
  else {
    const tb = (win.titlebar.isConnected ? win.titlebar : win.el).getBoundingClientRect();
    const ic = win.iconEl.getBoundingClientRect();
    at = { x: Math.max(4, (ic.width ? ic.left : tb.left) - 8), y: tb.top + Math.min(tb.height, 32) };
    e?.preventDefault?.();
    e?.stopPropagation?.();
  }
  win.focus();
  // The menu belongs to the window: it goes away with it (e.g. double-click on the icon closes).
  // (deferred: ui.menu wires its key handlers on the next tick and must not be closed before that)
  const off = win.on('close', () => setTimeout(() => ui.closeMenus(), 0));
  return openAccelMenu(at, items, { prevWin: win, keyboard: !fromMouse }).finally(off);
}

export function mount(ctx) {
  ui.loadCss('app://shell/core/features/winx.css');
  shell.on('winx:toggle', () => toggleWinX());
  shell.on('sysmenu:open', (win) => openSysMenu(win || wm.focused()));
  wm.on('titlebar-menu', (win, e) => openSysMenu(win, e));
  // Right-clicking Start opens the power-user menu (Windows behaviour), before the taskbar's own menu.
  document.addEventListener(
    'contextmenu',
    (e) => {
      if (e.defaultPrevented || !e.target.closest?.('#taskbar .tb-start')) return;
      e.preventDefault();
      e.stopPropagation();
      toggleWinX(e);
    },
    true,
  );
  ctx.winx = { toggle: toggleWinX, sysMenu: openSysMenu, get isOpen() { return winxOpen; } };
}
