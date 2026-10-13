# Fake session-bus app for test/sessionbus.test.mjs (run with python3 -I, on a private dbus-daemon).
# JSON lines on stdin:
#   {"cmd": "notify", "args": [app, replaces, icon, summary, body, [actions], {hints}, timeout]}   -> {"notified": id}
#   {"cmd": "close", "nid": 3}                       CloseNotification
#   {"cmd": "caps"} / {"cmd": "info"}                GetCapabilities / GetServerInformation
#   {"cmd": "sni", "name": "org.kde.StatusNotifierItem-1-1", "byPath": false}   export + register a tray item
#   {"cmd": "status", "value": "NeedsAttention"}     change Status (+ NewStatus)
#   {"cmd": "inhibit", "kind": "screen"|"power", "path": "/ScreenSaver", "app": "VLC", "reason": "Film"}
#                                                    -> {"inhibited": cookie}  (ScreenSaver or PowerManagement.Inhibit)
#   {"cmd": "uninhibit", "kind": "screen"|"power", "cookie": 3}  -> {"uninhibited": 3}
#   {"cmd": "hasInhibit"} / {"cmd": "active"} / {"cmd": "simulate"}   HasInhibit / GetActive / SimulateUserActivity
#   {"cmd": "quit"}
# stdout: READY, results, and every call/signal seen: {"signal": "ActionInvoked", ...}, {"call": "Activate", ...},
#         {"call": "Event", "id": 3, "event": "clicked"}
import json
import os
import sys

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

SNI = 'org.kde.StatusNotifierItem'
MENU = 'com.canonical.dbusmenu'


def out(o):
    sys.stdout.write(json.dumps(o) + '\n')
    sys.stdout.flush()


def v(x):
    return dbus.Dictionary(x, signature='sv')


# menu: 1 Ouvrir, 2 separator, 3 Mode silencieux (checkmark on), 4 Désactivé (disabled), 5 Plus > 6 À propos, 7 _Quitter
MENU_TREE = (0, {'children-display': 'submenu'}, [
    (1, {'label': 'Ouvrir la fenêtre'}, []),
    (2, {'type': 'separator'}, []),
    (3, {'label': 'Mode silencieux', 'toggle-type': 'checkmark', 'toggle-state': dbus.Int32(1)}, []),
    (4, {'label': 'Indisponible', 'enabled': False}, []),
    (8, {'label': 'Caché', 'visible': False}, []),
    (5, {'label': 'Plus', 'children-display': 'submenu'}, [(6, {'label': 'À propos'}, [])]),
    (7, {'label': '_Quitter'}, []),
])


def to_dbus(node):
    mid, props, kids = node
    return dbus.Struct((dbus.Int32(mid), v(props), dbus.Array([dbus.Struct(to_dbus(k), variant_level=1) for k in kids], signature='v')), signature=None)


class Menu(dbus.service.Object):
    @dbus.service.method(MENU, in_signature='iias', out_signature='u(ia{sv}av)')
    def GetLayout(self, parent, depth, props):
        return dbus.UInt32(1), to_dbus(MENU_TREE)

    @dbus.service.method(MENU, in_signature='i', out_signature='b')
    def AboutToShow(self, mid):
        out({'call': 'AboutToShow', 'id': int(mid)})
        return False

    @dbus.service.method(MENU, in_signature='isvu', out_signature='')
    def Event(self, mid, event, data, ts):
        out({'call': 'Event', 'id': int(mid), 'event': str(event)})


class Item(dbus.service.Object):
    def __init__(self, bus, path):
        super().__init__(bus, path)
        # 2x2 ARGB: opaque red, green, blue, half-transparent white
        px = bytes([255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 128, 255, 255, 255])
        self.props = {
            'Category': 'ApplicationStatus', 'Id': 'fake-chat', 'Title': 'Discussion', 'Status': 'Active',
            'IconName': '', 'IconPixmap': dbus.Array([dbus.Struct((dbus.Int32(2), dbus.Int32(2), dbus.Array(px, signature='y')))], signature='(iiay)'),
            'AttentionIconName': '', 'AttentionIconPixmap': dbus.Array([], signature='(iiay)'), 'OverlayIconName': '',
            'ToolTip': dbus.Struct(('', dbus.Array([], signature='(iiay)'), 'Discussion', '3 messages <b>non lus</b>'), signature='sa(iiay)ss'),
            'ItemIsMenu': False, 'Menu': dbus.ObjectPath('/MenuBar'), 'IconThemePath': '', 'WindowId': dbus.Int32(0),
        }

    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='ss', out_signature='v')
    def Get(self, iface, prop):
        return self.props[prop]

    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='s', out_signature='a{sv}')
    def GetAll(self, iface):
        return v(self.props)

    @dbus.service.method(SNI, in_signature='ii')
    def Activate(self, x, y):
        out({'call': 'Activate', 'x': int(x), 'y': int(y)})

    @dbus.service.method(SNI, in_signature='ii')
    def SecondaryActivate(self, x, y):
        out({'call': 'SecondaryActivate'})

    @dbus.service.method(SNI, in_signature='is')
    def Scroll(self, delta, orientation):
        out({'call': 'Scroll', 'delta': int(delta), 'orientation': str(orientation)})

    @dbus.service.signal(SNI, signature='s')
    def NewStatus(self, status):
        pass


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    loop = GLib.MainLoop()
    st = {'item': None, 'names': []}

    def notif():
        return dbus.Interface(bus.get_object('org.freedesktop.Notifications', '/org/freedesktop/Notifications'), 'org.freedesktop.Notifications')

    bus.add_signal_receiver(lambda i, k: out({'signal': 'ActionInvoked', 'id': int(i), 'key': str(k)}), 'ActionInvoked', 'org.freedesktop.Notifications')
    bus.add_signal_receiver(lambda i, r: out({'signal': 'NotificationClosed', 'id': int(i), 'reason': int(r)}), 'NotificationClosed', 'org.freedesktop.Notifications')

    def handle(m):
        c = m.get('cmd')
        if c == 'notify':
            a = m['args']
            hints = {}
            for k, x in (a[6] or {}).items():
                if k == 'urgency':
                    hints[k] = dbus.Byte(x)
                elif k == 'image-data':
                    w, h, data = x['w'], x['h'], bytes(x['data'])
                    ch = x.get('channels', 4)
                    hints[k] = dbus.Struct((dbus.Int32(w), dbus.Int32(h), dbus.Int32(w * ch), dbus.Boolean(ch == 4), dbus.Int32(8), dbus.Int32(ch), dbus.Array(data, signature='y')))
                elif isinstance(x, bool):
                    hints[k] = dbus.Boolean(x)
                else:
                    hints[k] = x
            nid = notif().Notify(a[0], dbus.UInt32(a[1]), a[2], a[3], a[4], dbus.Array(a[5], signature='s'), v(hints), dbus.Int32(a[7]))
            out({'notified': int(nid)})
        elif c == 'close':
            notif().CloseNotification(dbus.UInt32(m['nid']))
            out({'closed': m['nid']})
        elif c == 'caps':
            out({'caps': [str(x) for x in notif().GetCapabilities()]})
        elif c == 'info':
            out({'info': [str(x) for x in notif().GetServerInformation()]})
        elif c == 'sni':
            name = m.get('name')
            path = '/StatusNotifierItem'
            if name:
                st['names'].append(dbus.service.BusName(name, bus))
            st['item'] = Item(bus, path)
            Menu(bus, '/MenuBar')
            w = bus.get_object('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher')
            host = w.Get('org.kde.StatusNotifierWatcher', 'IsStatusNotifierHostRegistered', dbus_interface='org.freedesktop.DBus.Properties')
            w.RegisterStatusNotifierItem(path if m.get('byPath') else name, dbus_interface='org.kde.StatusNotifierWatcher')
            items = w.Get('org.kde.StatusNotifierWatcher', 'RegisteredStatusNotifierItems', dbus_interface='org.freedesktop.DBus.Properties')
            out({'sni': True, 'host': bool(host), 'items': [str(x) for x in items]})
        elif c == 'status':
            st['item'].props['Status'] = m['value']
            st['item'].NewStatus(m['value'])
            out({'status': m['value']})
        elif c in ('inhibit', 'uninhibit', 'hasInhibit', 'active', 'simulate'):
            power = m.get('kind') == 'power' or c == 'hasInhibit'
            if power:
                obj = dbus.Interface(bus.get_object('org.freedesktop.PowerManagement', '/org/freedesktop/PowerManagement/Inhibit'), 'org.freedesktop.PowerManagement.Inhibit')
            else:
                obj = dbus.Interface(bus.get_object('org.freedesktop.ScreenSaver', m.get('path') or '/org/freedesktop/ScreenSaver'), 'org.freedesktop.ScreenSaver')
            if c == 'inhibit':
                out({'inhibited': int(obj.Inhibit(m.get('app', ''), m.get('reason', '')))})
            elif c == 'uninhibit':
                obj.UnInhibit(dbus.UInt32(m['cookie']))
                out({'uninhibited': m['cookie']})
            elif c == 'hasInhibit':
                out({'hasInhibit': bool(obj.HasInhibit())})
            elif c == 'active':
                out({'active': bool(obj.GetActive())})
            else:
                obj.SimulateUserActivity()
                out({'simulated': True})
        elif c == 'quit':
            loop.quit()

    buf = [b'']

    def on_stdin(fd, cond):
        data = os.read(fd, 65536)
        if not data:
            loop.quit()
            return False
        buf[0] += data
        *lines, buf[0] = buf[0].split(b'\n')
        for line in lines:
            if line.strip():
                try:
                    handle(json.loads(line))
                except Exception as e:  # noqa: BLE001 — report to the test
                    out({'error': str(e)})
        return True

    GLib.io_add_watch(sys.stdin.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, on_stdin)
    out('READY')
    loop.run()


main()
