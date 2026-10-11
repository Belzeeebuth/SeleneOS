#!/usr/bin/python3 -I
"""Test fixture for xwm-helper.test.mjs: a tiny python-xlib X client.

  xclient.py shell    a stand-in shell window (40 px high strip at the bottom of the screen)
  xclient.py client   a client with _NET_WM_ICON (16 and 32 px), Motif "no decorations", min size,
                      WM_CLASS fixture/Fixture, _NET_WM_PID, _GTK_APPLICATION_ID and WM_DELETE_WINDOW

Prints "xid <XID>" once mapped, then reads commands on stdin (one per line) and answers "ok":
  fullscreen | unfullscreen | maximize   send _NET_WM_STATE (add / remove) about itself
  activate                               send _NET_ACTIVE_WINDOW about itself
  iconify                                send WM_CHANGE_STATE IconicState
  moveresize <dir> <x_root> <y_root>     send _NET_WM_MOVERESIZE (dir 8 = move, 4 = bottom-right)
  closemsg <xid>                         send _NET_CLOSE_WINDOW about <xid> (as a pager would)
  title <text>                           change _NET_WM_NAME
  minsize <w> <h>                        change WM_NORMAL_HINTS
  unmap                                  withdraw the window
Prints "delete" and exits when it receives WM_DELETE_WINDOW.
"""
import os
import select
import sys

from Xlib import X, Xatom, display
from Xlib.protocol import event

mode = sys.argv[1] if len(sys.argv) > 1 else 'client'
d = display.Display()
scr = d.screen()
root = scr.root
A = d.intern_atom

if mode == 'shell':
    w = root.create_window(0, scr.height_in_pixels - 40, scr.width_in_pixels, 40, 0, scr.root_depth,
                           background_pixel=scr.black_pixel, event_mask=X.StructureNotifyMask)
    w.set_wm_name('stand-in shell')
    w.set_wm_class('aurora', 'Aurora')
else:
    w = root.create_window(0, 0, 320, 200, 0, scr.root_depth, background_pixel=scr.white_pixel,
                           event_mask=X.StructureNotifyMask)
    w.set_wm_name('Fixture client')
    w.change_property(A('_NET_WM_NAME'), A('UTF8_STRING'), 8, 'Fixture client é'.encode())
    w.set_wm_class('fixture', 'Fixture')
    w.change_property(A('_NET_WM_PID'), Xatom.CARDINAL, 32, [os.getpid()])
    w.change_property(A('_GTK_APPLICATION_ID'), A('UTF8_STRING'), 8, b'org.example.Fixture')
    w.change_property(A('_NET_STARTUP_ID'), A('UTF8_STRING'), 8, b'fixture-startup-1')
    w.change_property(A('_MOTIF_WM_HINTS'), A('_MOTIF_WM_HINTS'), 32, [2, 0, 0, 0, 0])
    w.set_wm_normal_hints(flags=16 | 32, min_width=120, min_height=80, max_width=1000, max_height=700)
    w.set_wm_protocols([A('WM_DELETE_WINDOW')])
    icon = [16, 16] + [0xffff0000] * 256 + [32, 32] + [0x8000ff00] * 1024
    w.change_property(A('_NET_WM_ICON'), Xatom.CARDINAL, 32, icon)
w.map()
d.sync()
print('xid %d' % w.id, flush=True)


def send(win_id, kind, data):
    data = (list(data) + [0] * 5)[:5]
    ev = event.ClientMessage(window=d.create_resource_object('window', win_id), client_type=A(kind),
                             data=(32, data))
    root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)


def command(line):
    parts = line.split()
    if not parts:
        return
    c = parts[0]
    if c in ('fullscreen', 'unfullscreen'):
        send(w.id, '_NET_WM_STATE', [1 if c == 'fullscreen' else 0, A('_NET_WM_STATE_FULLSCREEN'), 0, 1])
    elif c == 'maximize':
        send(w.id, '_NET_WM_STATE', [1, A('_NET_WM_STATE_MAXIMIZED_VERT'), A('_NET_WM_STATE_MAXIMIZED_HORZ'), 1])
    elif c == 'activate':
        send(w.id, '_NET_ACTIVE_WINDOW', [1, X.CurrentTime, 0])
    elif c == 'iconify':
        send(w.id, 'WM_CHANGE_STATE', [3])
    elif c == 'moveresize':
        d.ungrab_pointer(X.CurrentTime)
        send(w.id, '_NET_WM_MOVERESIZE', [int(parts[2]), int(parts[3]), int(parts[1]), 1, 1])
    elif c == 'closemsg':
        send(int(parts[1]), '_NET_CLOSE_WINDOW', [X.CurrentTime, 2])
    elif c == 'title':
        w.change_property(A('_NET_WM_NAME'), A('UTF8_STRING'), 8, ' '.join(parts[1:]).encode())
    elif c == 'minsize':
        w.set_wm_normal_hints(flags=16, min_width=int(parts[1]), min_height=int(parts[2]))
    elif c == 'unmap':
        w.unmap()
        # ICCCM: a synthetic UnmapNotify on the root tells the WM the window is withdrawn.
        ev = event.UnmapNotify(event=root, window=w, from_configure=0)
        root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
    d.sync()
    print('ok', flush=True)


buf = b''
while True:
    while d.pending_events():
        e = d.next_event()
        if e.type == X.ClientMessage and e.client_type == A('WM_PROTOCOLS'):
            if e.data[1][0] == A('WM_DELETE_WINDOW'):
                print('delete', flush=True)
                sys.exit(0)
    r, _, _ = select.select([d.fileno(), 0], [], [], 1.0)
    if 0 in r:
        chunk = os.read(0, 4096)
        if not chunk:
            sys.exit(0)
        buf += chunk
        while b'\n' in buf:
            line, buf = buf.split(b'\n', 1)
            command(line.decode())
