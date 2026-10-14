# Fake MPRIS player AND probe client for test/sessionbus.test.mjs and test/music.test.mjs (python3 -I, private
# dbus-daemon only: DBUS_SESSION_BUS_ADDRESS).
# JSON lines on stdin:
#   {"cmd": "own", "name": "org.mpris.MediaPlayer2.fakeplayer", "identity": "Lecteur Test", "desktop": "",
#    "state": {...}}                         export a player (MediaPlayer2 + Player) -> {"owned": name}
#   {"cmd": "set", "state": {"PlaybackStatus": "Playing", "Metadata": {"title": …, "artist": …, "album": …,
#    "length": 200.0 (s), "art": "file:///…", "trackid": "/fake/track/1"}, "CanGoNext": true, …}}
#                                            change properties (+ PropertiesChanged with what changed)
#   {"cmd": "position", "value": 42.0}       the player's position (s), not signalled (spec)
#   {"cmd": "release"}                       leave the bus name (the player disappears)
#   probe side (an MPRIS client like playerctl / KDE Connect):
#   {"cmd": "watch", "name": "org.mpris.MediaPlayer2.selene"}   print its PropertiesChanged / Seeked signals
#   {"cmd": "get", "name": …, "iface": …, "prop": …}            -> {"got": prop, "value": …} or {"error": …}
#   {"cmd": "getall", "name": …, "iface": …}                    -> {"all": iface, "value": {...}}
#   {"cmd": "call", "name": …, "method": "PlayPause", "iface": …, "args": [...], "sig": "x"}  -> {"called": m} | {"error"}
#   {"cmd": "setprop", "name": …, "prop": "Volume", "value": 0.5, "sig": "d"}  -> {"setprop": prop} | {"error"}
#   {"cmd": "names"}                         -> {"names": [org.mpris.MediaPlayer2.* names on the bus]}
#   {"cmd": "quit"}
# stdout: READY, results, every call the fake player gets ({"call": "PlayPause"}, {"call": "Seek", "offset": µs},
#         {"call": "SetPosition", "track": path, "position": µs}) and the watched signals ({"signal": "PropertiesChanged",
#         "iface": …, "changed": {...}} / {"signal": "Seeked", "position": µs}).
import json
import os
import sys

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

PROPS = 'org.freedesktop.DBus.Properties'
ROOT = 'org.mpris.MediaPlayer2'
PLAYER = 'org.mpris.MediaPlayer2.Player'
PATH = '/org/mpris/MediaPlayer2'


def out(o):
    sys.stdout.write(json.dumps(o, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def plain(v):
    if isinstance(v, dbus.Boolean):
        return bool(v)
    if isinstance(v, (dbus.Byte, dbus.Int16, dbus.UInt16, dbus.Int32, dbus.UInt32, dbus.Int64, dbus.UInt64)):
        return int(v)
    if isinstance(v, dbus.Double):
        return float(v)
    if isinstance(v, (dbus.String, dbus.ObjectPath, dbus.Signature)):
        return str(v)
    if isinstance(v, (dbus.Array, list, dbus.Struct, tuple)):
        return [plain(x) for x in v]
    if isinstance(v, (dbus.Dictionary, dict)):
        return {str(k): plain(x) for k, x in v.items()}
    return v


def metadata(m):
    d = {'mpris:trackid': dbus.ObjectPath(m.get('trackid') or '/org/mpris/MediaPlayer2/TrackList/NoTrack')}
    if m.get('title') is not None:
        d['xesam:title'] = dbus.String(m['title'])
    if m.get('artist'):
        d['xesam:artist'] = dbus.Array([m['artist']], signature='s')
    if m.get('album'):
        d['xesam:album'] = dbus.String(m['album'])
    if m.get('length'):
        d['mpris:length'] = dbus.Int64(int(m['length'] * 1e6))
    if m.get('art'):
        d['mpris:artUrl'] = dbus.String(m['art'])
    return dbus.Dictionary(d, signature='sv')


BOOLS = ('CanGoNext', 'CanGoPrevious', 'CanPlay', 'CanPause', 'CanSeek', 'CanControl', 'Shuffle')


class Player(dbus.service.Object):
    def __init__(self, bus, identity, desktop):
        super().__init__(bus, PATH)
        self.root = {'Identity': dbus.String(identity), 'DesktopEntry': dbus.String(desktop), 'CanQuit': dbus.Boolean(False),
                     'CanRaise': dbus.Boolean(True), 'HasTrackList': dbus.Boolean(False),
                     'SupportedUriSchemes': dbus.Array([], signature='s'), 'SupportedMimeTypes': dbus.Array([], signature='s')}
        self.p = {'PlaybackStatus': dbus.String('Stopped'), 'LoopStatus': dbus.String('None'), 'Rate': dbus.Double(1.0),
                  'Metadata': metadata({}), 'Volume': dbus.Double(1.0), 'Position': dbus.Int64(0),
                  'MinimumRate': dbus.Double(1.0), 'MaximumRate': dbus.Double(1.0)}
        for k in BOOLS:
            self.p[k] = dbus.Boolean(k != 'Shuffle')

    def apply(self, st):
        changed = {}
        for k, v in st.items():
            if k == 'Metadata':
                val = metadata(v)
            elif k in BOOLS:
                val = dbus.Boolean(bool(v))
            elif k in ('Rate', 'Volume'):
                val = dbus.Double(float(v))
            else:
                val = dbus.String(str(v))
            self.p[k] = val
            changed[k] = val
        if changed:
            self.PropertiesChanged(PLAYER, dbus.Dictionary(changed, signature='sv'), dbus.Array([], signature='s'))

    def props(self, iface):
        return self.root if iface == ROOT else self.p if iface == PLAYER else {}

    @dbus.service.method(PROPS, in_signature='ss', out_signature='v')
    def Get(self, iface, prop):
        return self.props(str(iface))[str(prop)]

    @dbus.service.method(PROPS, in_signature='s', out_signature='a{sv}')
    def GetAll(self, iface):
        return dbus.Dictionary(self.props(str(iface)), signature='sv')

    @dbus.service.method(PROPS, in_signature='ssv', out_signature='')
    def Set(self, iface, prop, value):
        out({'call': 'Set', 'prop': str(prop), 'value': plain(value)})

    @dbus.service.signal(PROPS, signature='sa{sv}as')
    def PropertiesChanged(self, iface, changed, invalidated):
        pass

    @dbus.service.signal(PLAYER, signature='x')
    def Seeked(self, position):
        pass

    @dbus.service.method(ROOT, in_signature='', out_signature='')
    def Raise(self):
        out({'call': 'Raise'})

    @dbus.service.method(ROOT, in_signature='', out_signature='')
    def Quit(self):
        out({'call': 'Quit'})

    def _simple(self, name):
        out({'call': name})

    @dbus.service.method(PLAYER, in_signature='', out_signature='')
    def PlayPause(self):
        self._simple('PlayPause')
        self.apply({'PlaybackStatus': 'Paused' if str(self.p['PlaybackStatus']) == 'Playing' else 'Playing'})

    @dbus.service.method(PLAYER, in_signature='', out_signature='')
    def Play(self):
        self._simple('Play')
        self.apply({'PlaybackStatus': 'Playing'})

    @dbus.service.method(PLAYER, in_signature='', out_signature='')
    def Pause(self):
        self._simple('Pause')
        self.apply({'PlaybackStatus': 'Paused'})

    @dbus.service.method(PLAYER, in_signature='', out_signature='')
    def Stop(self):
        self._simple('Stop')
        self.apply({'PlaybackStatus': 'Stopped'})

    @dbus.service.method(PLAYER, in_signature='', out_signature='')
    def Next(self):
        self._simple('Next')

    @dbus.service.method(PLAYER, in_signature='', out_signature='')
    def Previous(self):
        self._simple('Previous')

    @dbus.service.method(PLAYER, in_signature='x', out_signature='')
    def Seek(self, offset):
        out({'call': 'Seek', 'offset': int(offset)})

    @dbus.service.method(PLAYER, in_signature='ox', out_signature='')
    def SetPosition(self, track, position):
        out({'call': 'SetPosition', 'track': str(track), 'position': int(position)})
        self.p['Position'] = dbus.Int64(int(position))
        self.Seeked(dbus.Int64(int(position)))

    @dbus.service.method(PLAYER, in_signature='s', out_signature='')
    def OpenUri(self, uri):
        out({'call': 'OpenUri', 'uri': str(uri)})


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    loop = GLib.MainLoop()
    state = {'player': None, 'name': None}

    def on_signal(*args, member=None, sender=None, path=None, interface=None):
        if member == 'PropertiesChanged':
            out({'signal': 'PropertiesChanged', 'iface': str(args[0]), 'changed': plain(args[1]), 'invalidated': plain(args[2])})
        elif member == 'Seeked':
            out({'signal': 'Seeked', 'position': int(args[0])})

    def handle(msg):
        cmd = msg.get('cmd')
        if cmd == 'quit':
            loop.quit()
        elif cmd == 'own':
            state['player'] = Player(bus, msg.get('identity', 'Fake'), msg.get('desktop', ''))
            if msg.get('state'):
                state['player'].apply(msg['state'])
            state['name'] = msg['name']
            bus.request_name(msg['name'], dbus.bus.NAME_FLAG_DO_NOT_QUEUE)
            out({'owned': msg['name']})
        elif cmd == 'set':
            state['player'].apply(msg.get('state') or {})
            out({'set': True})
        elif cmd == 'position':
            state['player'].p['Position'] = dbus.Int64(int(float(msg['value']) * 1e6))
            out({'position': True})
        elif cmd == 'release':
            bus.release_name(state['name'])
            state['player'].remove_from_connection()
            out({'released': state['name']})
        elif cmd == 'watch':
            owner = str(bus.get_name_owner(msg['name']))
            bus.add_signal_receiver(on_signal, sender_keyword='sender', member_keyword='member', path_keyword='path', interface_keyword='interface', bus_name=owner, path=PATH)
            out({'watching': msg['name']})
        elif cmd in ('get', 'getall', 'call', 'setprop'):
            try:
                obj = bus.get_object(msg['name'], PATH, introspect=False)
                if cmd == 'get':
                    out({'got': msg['prop'], 'value': plain(obj.Get(msg['iface'], msg['prop'], dbus_interface=PROPS))})
                elif cmd == 'getall':
                    out({'all': msg['iface'], 'value': plain(obj.GetAll(msg['iface'], dbus_interface=PROPS))})
                elif cmd == 'setprop':
                    sig = msg.get('sig', 's')
                    v = {'d': dbus.Double, 'b': dbus.Boolean, 's': dbus.String}[sig](msg['value'], variant_level=1)
                    obj.Set(PLAYER, msg['prop'], v, dbus_interface=PROPS)
                    out({'setprop': msg['prop']})
                else:
                    sig = msg.get('sig', '')
                    conv = {'x': dbus.Int64, 's': dbus.String, 'o': dbus.ObjectPath}
                    args = [conv[c](a) for c, a in zip(sig, msg.get('args', []))]
                    getattr(obj, msg['method'])(*args, dbus_interface=msg.get('iface', PLAYER))
                    out({'called': msg['method']})
            except dbus.DBusException as e:
                out({'error': e.get_dbus_name(), 'cmd': cmd, 'message': e.get_dbus_message()})
        elif cmd == 'names':
            out({'names': sorted(str(n) for n in bus.list_names() if str(n).startswith(ROOT + '.'))})

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
                handle(json.loads(line))
        return True

    GLib.io_add_watch(sys.stdin.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, on_stdin)
    out('READY')
    loop.run()


if __name__ == '__main__':
    main()
