// Desktop notifications from Linux and Flatpak apps (org.freedesktop.Notifications, main/ipc/sessionbus.js +
// helpers/aurora-sessionbus) shown as Selene notifications: toast + notification centre, action buttons, the app's
// icon (icon theme) or its picture (image-data / image-path hint).
//   - Ne pas déranger / Focus mode: kept in the centre without a toast (notify.js); a critical notification
//     (urgency 2) still shows its toast, like alarms, and stays until it is closed.
//   - The "default" action is a click on the toast; other actions are buttons (at most 3).
//   - Removed from the centre (or toast clicked) -> NotificationClosed 2; a transient notification leaves the centre
//     when its toast expires -> NotificationClosed 1; CloseNotification from the app removes it.
//   - replaces_id updates the notification in place (same entry, toast shown again).
export function mount({ api, notify, notifications }) {
  const toSelene = new Map(); // D-Bus id -> Selene id
  const toDbus = new Map(); // Selene id -> D-Bus id
  const expiring = new Set(); // Selene ids removed by their own timeout (transient)
  const forget = (sid) => {
    const did = toDbus.get(sid);
    toDbus.delete(sid);
    if (did != null && toSelene.get(did) === sid) toSelene.delete(did);
    return did;
  };

  api.on('notify:desktop', (n) => {
    if (!n || !Number.isInteger(n.id)) return;
    const old = toSelene.get(n.id);
    if (old != null) {
      forget(old); // replaced: the old entry goes without telling the app it was closed
      notifications.dismiss(old);
    }
    const send = (key) => api.invoke('notify:desktopAction', n.id, key).catch(() => null);
    const def = n.actions.find((a) => a.key === 'default');
    const sid = notify({
      title: n.title,
      body: n.body,
      icon: n.icon || 'bell',
      image: n.image || null,
      appId: `dbus:${n.appId || n.appName || 'app'}`,
      appName: n.appName || n.title,
      timeout: n.timeout,
      silent: n.silent,
      urgent: n.urgency === 2,
      onClick: def ? () => send('default') : undefined,
      actions: n.actions
        .filter((a) => a.key !== 'default' && a.label)
        .slice(0, 3)
        .map((a) => ({ label: a.label, keep: n.resident, onClick: () => send(a.key) })),
    });
    toSelene.set(n.id, sid);
    toDbus.set(sid, n.id);
    if (n.transient && n.timeout > 0) {
      setTimeout(() => {
        if (!toDbus.has(sid)) return;
        expiring.add(sid);
        notifications.dismiss(sid);
      }, n.timeout);
    }
  });

  api.on('notify:desktopClose', ({ id } = {}) => {
    const sid = toSelene.get(id);
    if (sid == null) return;
    forget(sid);
    notifications.dismiss(sid);
  });

  // Whatever removed it (×, « Tout effacer », click, action), the app learns it is closed.
  notifications.on('change', () => {
    if (!toDbus.size) return;
    const live = new Set(notifications.list().map((x) => x.id));
    for (const sid of [...toDbus.keys()]) {
      if (live.has(sid)) continue;
      const did = forget(sid);
      const reason = expiring.delete(sid) ? 1 : 2;
      api.invoke('notify:desktopClosed', did, reason).catch(() => null);
    }
  });
}
