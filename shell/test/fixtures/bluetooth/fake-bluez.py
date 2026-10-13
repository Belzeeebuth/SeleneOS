#!/usr/bin/python3
# A tiny fake BlueZ (org.bluez) for shell/test/bluetooth.test.mjs: run on a private dbus-daemon, never on
# the real system bus. One adapter (hci0), two paired devices (headphones with Battery1, keyboard) and,
# once discovery starts, a phone (pairing asks the agent RequestConfirmation 123456) and a gamepad
# (pairing asks RequestPinCode; the PIN must be 0000).
# Prints "READY" when the name is owned. Writes the agent calls it made to stdout ("AGENT <method> …").
import sys

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

PROPS = 'org.freedesktop.DBus.Properties'
OM = 'org.freedesktop.DBus.ObjectManager'


class Obj(dbus.service.Object):
    def __init__(self, bus, path, ifaces):
        super().__init__(bus, path)
        self.path = path
        self.ifaces = ifaces  # iface -> dict

    @dbus.service.method(PROPS, in_signature='ss', out_signature='v')
    def Get(self, iface, name):
        return self.ifaces[iface][name]

    @dbus.service.method(PROPS, in_signature='s', out_signature='a{sv}')
    def GetAll(self, iface):
        return self.ifaces.get(iface, {})

    @dbus.service.method(PROPS, in_signature='ssv', out_signature='')
    def Set(self, iface, name, value):
        if iface == 'org.bluez.Adapter1' and name == 'Powered' and ROOT.blocked and value:
            raise dbus.DBusException('Blocked through rfkill', name='org.bluez.Error.Blocked')
        self.set(iface, name, value)

    def set(self, iface, name, value):
        self.ifaces[iface][name] = value
        self.PropertiesChanged(iface, {name: value}, [])

    @dbus.service.signal(PROPS, signature='sa{sv}as')
    def PropertiesChanged(self, iface, changed, invalidated):
        pass


class Root(dbus.service.Object):
    def __init__(self, bus):
        super().__init__(bus, '/')
        self.objs = {}
        self.blocked = '--blocked' in sys.argv

    @dbus.service.method(OM, in_signature='', out_signature='a{oa{sa{sv}}}')
    def GetManagedObjects(self):
        return {p: o.ifaces for p, o in self.objs.items()}

    @dbus.service.signal(OM, signature='oa{sa{sv}}')
    def InterfacesAdded(self, path, ifaces):
        pass

    @dbus.service.signal(OM, signature='oas')
    def InterfacesRemoved(self, path, ifaces):
        pass

    def add(self, obj, announce=True):
        self.objs[obj.path] = obj
        if announce:
            self.InterfacesAdded(obj.path, obj.ifaces)

    def remove(self, path):
        o = self.objs.pop(path, None)
        if o:
            o.remove_from_connection()
            self.InterfacesRemoved(path, list(o.ifaces.keys()))


class AgentManager(dbus.service.Object):
    def __init__(self, bus):
        super().__init__(bus, '/org/bluez')
        self.agent = None

    @dbus.service.method('org.bluez.AgentManager1', in_signature='os', out_signature='', sender_keyword='sender')
    def RegisterAgent(self, path, capability, sender=None):
        self.agent = (sender, path)
        print('AGENT RegisterAgent %s %s' % (path, capability), flush=True)

    @dbus.service.method('org.bluez.AgentManager1', in_signature='o', out_signature='')
    def RequestDefaultAgent(self, path):
        print('AGENT RequestDefaultAgent %s' % path, flush=True)

    @dbus.service.method('org.bluez.AgentManager1', in_signature='o', out_signature='')
    def UnregisterAgent(self, path):
        self.agent = None


class Adapter(Obj):
    @dbus.service.method('org.bluez.Adapter1', in_signature='', out_signature='')
    def StartDiscovery(self):
        if not self.ifaces['org.bluez.Adapter1']['Powered']:
            raise dbus.DBusException('Resource Not Ready', name='org.bluez.Error.NotReady')
        self.set('org.bluez.Adapter1', 'Discovering', dbus.Boolean(True))
        GLib.timeout_add(200, self.found)

    def found(self):
        for addr, name, icon, cls in (('11:22:33:44:55:66', 'Pixel 8 de Camille', 'phone', 0x5A020C), ('77:88:99:AA:BB:CC', 'Manette sans fil', 'input-gaming', 0x002508)):
            path = '/org/bluez/hci0/dev_' + addr.replace(':', '_')
            if path not in ROOT.objs:
                ROOT.add(Device(self.connection, path, device(addr, name, icon, cls, paired=False, rssi=-52)))
        return False

    @dbus.service.method('org.bluez.Adapter1', in_signature='', out_signature='')
    def StopDiscovery(self):
        if not self.ifaces['org.bluez.Adapter1']['Discovering']:
            raise dbus.DBusException('No discovery started', name='org.bluez.Error.Failed')
        self.set('org.bluez.Adapter1', 'Discovering', dbus.Boolean(False))

    @dbus.service.method('org.bluez.Adapter1', in_signature='a{sv}', out_signature='')
    def SetDiscoveryFilter(self, f):
        pass

    @dbus.service.method('org.bluez.Adapter1', in_signature='o', out_signature='')
    def RemoveDevice(self, path):
        if path not in ROOT.objs:
            raise dbus.DBusException('Does Not Exist', name='org.bluez.Error.DoesNotExist')
        ROOT.remove(path)


class Device(Obj):
    D = 'org.bluez.Device1'

    @dbus.service.method('org.bluez.Device1', in_signature='', out_signature='', async_callbacks=('ok', 'err'))
    def Pair(self, ok, err):
        d = self.ifaces[self.D]
        if d['Paired']:
            return err(dbus.DBusException('Already Exists', name='org.bluez.Error.AlreadyExists'))
        sender, apath = AGENTS.agent
        agent = dbus.Interface(self.connection.get_object(sender, apath), 'org.bluez.Agent1')

        def done(*_):
            self.set(self.D, 'Paired', dbus.Boolean(True))
            self.set(self.D, 'Bonded', dbus.Boolean(True))
            ok()

        def fail(e):
            print('AGENT error %s' % e.get_dbus_name(), flush=True)
            err(dbus.DBusException('Authentication Rejected', name='org.bluez.Error.AuthenticationRejected'))

        if d['Icon'] == 'input-gaming':
            def pin(value):
                print('AGENT RequestPinCode -> %s' % value, flush=True)
                done() if value == '0000' else err(dbus.DBusException('Authentication Failed', name='org.bluez.Error.AuthenticationFailed'))
            agent.RequestPinCode(dbus.ObjectPath(self.path), reply_handler=pin, error_handler=fail, timeout=30)
        else:
            def confirmed():
                print('AGENT RequestConfirmation ok', flush=True)
                done()
            agent.RequestConfirmation(dbus.ObjectPath(self.path), dbus.UInt32(123456), reply_handler=confirmed, error_handler=fail, timeout=30)

    @dbus.service.method('org.bluez.Device1', in_signature='', out_signature='')
    def Connect(self):
        self.set(self.D, 'Connected', dbus.Boolean(True))

    @dbus.service.method('org.bluez.Device1', in_signature='', out_signature='')
    def Disconnect(self):
        self.set(self.D, 'Connected', dbus.Boolean(False))

    @dbus.service.method('org.bluez.Device1', in_signature='', out_signature='')
    def CancelPairing(self):
        pass


def device(addr, name, icon, cls, paired, connected=False, rssi=None):
    d = {
        'Address': addr, 'Name': name, 'Alias': name, 'Icon': icon, 'Class': dbus.UInt32(cls),
        'Paired': dbus.Boolean(paired), 'Bonded': dbus.Boolean(paired), 'Connected': dbus.Boolean(connected),
        'Trusted': dbus.Boolean(paired), 'Blocked': dbus.Boolean(False), 'Adapter': dbus.ObjectPath('/org/bluez/hci0'),
        'UUIDs': dbus.Array([], signature='s'),
    }
    if rssi is not None:
        d['RSSI'] = dbus.Int16(rssi)
    return {'org.bluez.Device1': d}


def main():
    global ROOT, AGENTS
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    ROOT = Root(bus)
    AGENTS = AgentManager(bus)
    ROOT.add(Adapter(bus, '/org/bluez/hci0', {'org.bluez.Adapter1': {
        'Address': '00:1A:7D:DA:71:13', 'Name': 'selene', 'Alias': 'selene', 'Powered': dbus.Boolean(False),
        'PowerState': 'off-blocked' if ROOT.blocked else 'off', 'Discovering': dbus.Boolean(False), 'Discoverable': dbus.Boolean(False),
    }}), announce=False)
    head = device('AC:80:0A:12:34:56', 'Casque WH-1000XM4', 'audio-headphones', 0x240404, paired=True, connected=True)
    head['org.bluez.Battery1'] = {'Percentage': dbus.Byte(80)}
    ROOT.add(Device(bus, '/org/bluez/hci0/dev_AC_80_0A_12_34_56', head), announce=False)
    ROOT.add(Device(bus, '/org/bluez/hci0/dev_E4_17_D8_00_00_01', device('E4:17:D8:00:00:01', 'Clavier K380', 'input-keyboard', 0x002540, paired=True)), announce=False)
    name = dbus.service.BusName('org.bluez', bus)  # noqa: F841 (kept alive: the name is released when collected)
    print('READY', flush=True)
    GLib.MainLoop().run()


ROOT = None
AGENTS = None
if __name__ == '__main__':
    main()
