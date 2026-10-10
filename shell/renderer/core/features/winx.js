// Power-user menu (Super+X, or right-click on the Start button) and the window menu
// (right-click on a title bar, click on the window icon, or Alt+Space).
// Both menus support Windows-style accelerator keys (the underlined letter).
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
      apps: 'Installed a&pps',
      power: 'P&ower Options',
      system: 'S&ystem',
      network: 'Net&work Connections',
      disks: 'Dis&k Management',
      terminal: 'Term&inal',
      taskmgr: '&Task Manager',
      settings: 'Setti&ngs',
      files: 'File &Explorer',
      search: '&Search',
      run: '&Run',
      shutdownMenu: 'Sh&ut down or sign out',
      desktop: '&Desktop',
      signOut: 'S&ign out',
      sleep: '&Sleep',
      shutdown: 'Sh&ut down',
      restart: '&Restart',
    },
    sysmenu: { restore: '&Restore', move: '&Move', size: '&Size', minimize: 'Mi&nimize', maximize: 'Ma&ximize', close: '&Close' },
  },
  fr: {
    winx: {
      apps: '&Applications installées',
      power: "&Options d'alimentation",
      system: 'S&ystème',
      network: 'Connexions &réseau',
      disks: 'Gestion des &disques',
      terminal: '&Terminal',
      taskmgr: '&Gestionnaire des tâches',
      settings: '&Paramètres',
      files: '&Explorateur de fichiers',
      search: 'Re&chercher',
      run: 'E&xécuter',
      shutdownMenu: 'Arrêter o&u se déconnecter',
      desktop: '&Bureau',
      signOut: 'Se &déconnecter',
      sleep: 'Mettre en &veille',
      shutdown: '&Arrêter',
      restart: '&Redémarrer',
    },
    sysmenu: { restore: '&Restaurer', move: '&Déplacer', size: '&Taille', minimize: 'Réd&uire', maximize: '&Agrandir', close: '&Fermer' },
  },
});

// "&Task Manager" -> <span>…<u>T</u>…</span> ; the accelerator is the letter after '&'.
function accel(key) {
  const text = t(key);
  const i = text.indexOf('&');
  if (i < 0 || i === text.length - 1) return text;
  return h('span', { class: 'accel-label' }, text.slice(0, i), h('u', null, text[i + 1]), text.slice(i + 2));
}

// Pressing an underlined letter activates that item in the top-most open menu.
function onAccelKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1) return;
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
  return out;
}

async function openAccelMenu(at, items, { prevWin, keyboard = true, above = false } = {}) {
  items = tidy(items);
  document.addEventListener('keydown', onAccelKey, true);
  const p = ui.menu(at, items, { class: ['wm-accel-menu', keyboard ? 'kbd' : ''].join(' '), above });
  // Put the keyboard in the menu (it may have been inside a webview).
  const el = [...document.querySelectorAll('body > .menu')].pop();
  el?.focus({ preventScroll: true });
  const res = await p;
  document.removeEventListener('keydown', onAccelKey, true);
  if (!res && prevWin && wm.focused() === prevWin) prevWin.focusContent();
  return res;
}

// ------------------------------------------------------------------ Win+X
let winxOpen = false;

function winxItems() {
  const has = (id) => !!registry.get(id);
  return [
    { label: accel('winx.apps'), hidden: !has('settings'), action: () => launch('settings', { page: 'installedApps' }) },
    { label: accel('winx.power'), hidden: !has('settings'), action: () => launch('settings', { page: 'power' }) },
    { label: accel('winx.system'), hidden: !has('settings'), action: () => launch('settings', { page: 'about' }) },
    { label: accel('winx.network'), hidden: !has('settings'), action: () => launch('settings', { page: 'network' }) },
    { label: accel('winx.disks'), hidden: !has('files'), action: () => launch('files', { path: 'thispc' }) },
    '-',
    { label: accel('winx.terminal'), hidden: !has('terminal'), action: () => launch('terminal') },
    { label: accel('winx.taskmgr'), hidden: !has('taskmgr'), action: () => launch('taskmgr') },
    { label: accel('winx.settings'), hidden: !has('settings'), action: () => launch('settings') },
    { label: accel('winx.files'), hidden: !has('files'), action: () => launch('files') },
    { label: accel('winx.search'), action: () => shell.emit('search:open', { query: '' }) },
    { label: accel('winx.run'), action: () => shell.emit('run:open') },
    '-',
    {
      label: accel('winx.shutdownMenu'),
      submenu: [
        // Same path as the Ctrl+Alt+Del / Alt+F4 power options: apps get to veto (unsaved work), errors are shown.
        { label: accel('winx.signOut'), action: () => powerAction('signOut') },
        { label: accel('winx.sleep'), action: () => powerAction('sleep') },
        { label: accel('winx.shutdown'), action: () => powerAction('shutdown') },
        { label: accel('winx.restart'), action: () => powerAction('restart') },
      ],
    },
    { label: accel('winx.desktop'), action: () => wm.toggleDesktop() },
  ];
}

export async function toggleWinX() {
  if (winxOpen) {
    ui.closeMenus();
    return;
  }
  shell.emit('start:close');
  shell.emit('flyouts:close');
  const start = document.querySelector('#taskbar .tb-start');
  const r = start?.getBoundingClientRect();
  // Above the Start button with the same gap as the Start menu (never touching the taskbar).
  const barTop = Math.min(r?.top ?? Infinity, document.getElementById('taskbar')?.getBoundingClientRect().top ?? Infinity, window.innerHeight - wm.insets.bottom);
  const lift = Number.isFinite(barTop) ? barTop - 8 : window.innerHeight - 56;
  const at = r && r.width ? { x: r.left, y: lift, anchor: new DOMRect(r.left, lift, r.width, 1) } : { x: 12, y: lift, anchor: new DOMRect(12, lift, 40, 1) };
  winxOpen = true;
  start?.classList.add('open');
  try {
    await openAccelMenu(at, winxItems(), { prevWin: wm.focused(), above: true });
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
      toggleWinX();
    },
    true,
  );
  ctx.winx = { toggle: toggleWinX, sysMenu: openSysMenu, get isOpen() { return winxOpen; } };
}
