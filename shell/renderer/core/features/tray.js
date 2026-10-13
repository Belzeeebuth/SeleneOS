// App tray icons (StatusNotifierItem, main/ipc/sessionbus.js + helpers/aurora-sessionbus) in the bar, before the
// Réglages rapides button: left click Activate (or the menu for menu-only items), middle click SecondaryActivate,
// wheel Scroll, right click the app's own menu (com.canonical.dbusmenu) drawn as a Selene menu (labels, separators,
// disabled entries, checkmarks / radio items, submenus). Passive items are hidden; NeedsAttention shows the
// attention icon with a small accent dot. Tooltip: the item's ToolTip (title, body).
// Also starts the XDG autostart entries once the shell is ready (main/ipc/autostart.js).
export function mount({ api, taskbar, ui, h, i18n, t, shell }) {
  i18n.extend({
    en: { trayApps: { noMenu: 'This app has no menu.', noAnswer: '{app} is not answering.', app: 'This app' } },
    fr: { trayApps: { noMenu: 'Cette application n’a pas de menu.', noAnswer: '{app} ne répond pas.', app: 'Cette application' } },
  });
  ui.loadCss('app://shell/core/features/tray.css');
  let items = [];
  let host = null;

  const tip = (it) => [it.tooltip?.title || it.title, it.tooltip?.body].filter(Boolean).join(' — ');
  const toMenu = (key, entries) => {
    const toggles = entries.some((e) => e.toggle); // keep labels aligned when some entries have a check mark
    return entries.map((e) =>
      e.type === 'separator'
        ? '-'
        : {
            label: e.label || '…',
            disabled: !e.enabled,
            checked: e.toggle ? e.state === 1 : toggles ? false : undefined,
            submenu: e.children?.length ? toMenu(key, e.children) : undefined,
            action: e.children?.length ? undefined : () => api.invoke('tray:menuEvent', key, e.id).catch(() => null),
          },
    );
  };

  async function openMenu(it, btn) {
    let entries = [];
    try {
      entries = await api.invoke('tray:menu', it.key);
    } catch (err) {
      entries = null;
      console.warn('[tray] menu', it.id, err?.code || err?.message);
    }
    if (!btn.isConnected) return;
    const at = btn;
    const above = !['top'].includes(taskbar.layout().position);
    if (!entries?.length) {
      ui.menu(at, [{ label: entries ? t('trayApps.noMenu') : t('trayApps.noAnswer', { app: it.title || t('trayApps.app') }), disabled: true }], { above, class: 'tray-menu' });
      return;
    }
    ui.menu(at, toMenu(it.key, entries), { above, class: 'tray-menu' });
  }

  function render() {
    if (!host?.isConnected) return;
    const shown = items.filter((it) => it.status !== 'Passive' && it.icon);
    host.replaceChildren(
      ...shown.map((it) =>
        h(
          'button',
          {
            class: ['tb-btn', 'tb-sni-item', it.status === 'NeedsAttention' && 'attention'],
            dataset: { key: it.key, tip: tip(it) },
            'aria-label': tip(it) || it.id,
            onclick: async (e) => {
              const btn = e.currentTarget;
              if (it.itemIsMenu && it.menu) return openMenu(it, btn);
              try {
                await api.invoke('tray:activate', it.key, Math.round(e.screenX), Math.round(e.screenY));
              } catch {
                if (it.menu) openMenu(it, btn); // no Activate (e.g. libappindicator items): the menu instead
              }
            },
            onauxclick: (e) => {
              if (e.button === 1) api.invoke('tray:secondary', it.key, Math.round(e.screenX), Math.round(e.screenY)).catch(() => null);
            },
            oncontextmenu: (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (it.menu) openMenu(it, e.currentTarget);
            },
            onwheel: (e) => {
              const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY);
              const d = horiz ? e.deltaX : e.deltaY;
              if (d) api.invoke('tray:scroll', it.key, d > 0 ? -1 : 1, horiz ? 'horizontal' : 'vertical').catch(() => null);
            },
          },
          h('img', { class: 'tb-sni-icon', src: it.icon, alt: '', draggable: false, width: 18, height: 18 }),
        ),
      ),
    );
    host.hidden = !shown.length;
  }

  taskbar.setTrayRenderer?.((el) => {
    host = el;
    render();
  });
  api.on('tray:items', (list) => {
    const before = items.filter((it) => it.status !== 'Passive').length;
    items = Array.isArray(list) ? list : [];
    render();
    if (before !== items.filter((it) => it.status !== 'Passive').length) taskbar.trayChanged?.();
  });
  api
    .invoke('tray:list')
    .then((list) => {
      if (Array.isArray(list) && list.length) {
        items = list;
        render();
        taskbar.trayChanged?.();
      }
    })
    .catch(() => null);

  // XDG autostart once the desktop is drawn (Moniteur système > Démarrage decides what runs).
  shell.on?.('ready', () => {
    setTimeout(() => api.invoke('autostart:run').catch((err) => console.warn('[autostart]', err?.message)), 1500);
  });
  window.__aurora.tray = { items: () => items, openMenu: (key) => openMenu(items.find((x) => x.key === key), host?.querySelector(`[data-key="${CSS.escape(key)}"]`)) };
}
