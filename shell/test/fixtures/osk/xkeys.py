#!/usr/bin/python3
"""Test fixture for osk.test.mjs (« Clavier visuel » through aurora-xwm): a tiny python-xlib X client.

  xkeys.py client   a 400x200 window at the top left that reports every key it receives
  xkeys.py shell    a stand-in shell window: a strip over the bottom 320 px of the screen (where the on-screen
                    keyboard would be); its commands do what Chromium does when the keyboard is clicked

Prints "xid <XID>" once mapped. Client events, one JSON line each:
  {"ev": "key", "keycode": K, "state": S, "keysym": KS, "char": "é" | null}   a KeyPress; the keysym is read from the
      core keymap like a non-XKB client (column 1 with Shift, 4 / 5 with Mod5 = AltGr, Caps Lock on a letter), after
      refreshing the keymap on MappingNotify (a borrowed spare keycode is seen)
  {"ev": "focus", "in": true | false}
Commands on stdin (one per line), answered "ok" (or a line of output):
  getfocus                  prints "focus <XID of the focus window's top-level>"
  takefocus                 XSetInputFocus on itself (Chromium on a click when it does not use _NET_ACTIVE_WINDOW)
  activate                  send _NET_ACTIVE_WINDOW about itself (Chromium on a click with an EWMH window manager)
  pointer <x> <y>           move the pointer there (XTest)
  keys <keysym>...          press then release keys with XTest (e.g. Caps_Lock)
"""
import json
import select
import sys

from Xlib import X, XK, display
from Xlib.ext import xtest
from Xlib.protocol import event

XK.load_keysym_group('xkb')
NAMES = {}
for _n in dir(XK):
    if _n.startswith('XK_'):
        NAMES.setdefault(getattr(XK, _n), _n[3:])
mode = sys.argv[1] if len(sys.argv) > 1 else 'client'
d = display.Display()
scr = d.screen()
root = scr.root
A = d.intern_atom


def keysym_char(ks):
    if 0x20 <= ks < 0x7f or 0xa0 <= ks < 0x100:
        return chr(ks)
    legacy = {0x20ac: 0x20ac, 0x13bd: 0x153, 0x13bc: 0x152, 0x13be: 0x178}
    if ks in legacy:
        return chr(legacy[ks])
    if ks & 0xff000000 == 0x01000000:
        return chr(ks & 0xffffff)
    return None


if mode == 'shell':
    w = root.create_window(0, scr.height_in_pixels - 320, scr.width_in_pixels, 320, 0, scr.root_depth,
                           background_pixel=scr.black_pixel, event_mask=X.StructureNotifyMask)
    w.set_wm_name('stand-in shell')
else:
    w = root.create_window(0, 0, 400, 200, 0, scr.root_depth, background_pixel=scr.white_pixel,
                           event_mask=X.StructureNotifyMask | X.KeyPressMask | X.FocusChangeMask)
    w.set_wm_name('osk test client')
    w.set_wm_class('xkeys', 'Xkeys')
w.map()
d.sync()
print('xid %d' % w.id, flush=True)


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def top_of(win):
    wid = win.id if hasattr(win, 'id') else int(win)
    for _ in range(32):
        if wid in (0, 1, root.id):
            return wid
        try:
            parent = d.create_resource_object('window', wid).query_tree().parent
        except Exception:
            return 0
        pid = parent.id if hasattr(parent, 'id') else int(parent)
        if pid == root.id:
            return wid
        wid = pid
    return 0


buf = b''
while True:
    while d.pending_events():
        e = d.next_event()
        if e.type == X.MappingNotify:
            d.refresh_keyboard_mapping(e)
        elif e.type == X.KeyPress:
            st = e.state
            level3 = bool(st & X.Mod5Mask)
            shift = bool(st & X.ShiftMask)
            col = (4 if level3 else 0) + (1 if shift else 0)
            ks = d.keycode_to_keysym(e.detail, col)
            if st & X.LockMask and not level3:
                lo, up = d.keycode_to_keysym(e.detail, 0), d.keycode_to_keysym(e.detail, 1)
                a, b = keysym_char(lo), keysym_char(up)
                if a and b and a != b and a.upper() == b:
                    ks = lo if shift else up
            if not ks and col:
                ks = d.keycode_to_keysym(e.detail, col & 1)
            out({'ev': 'key', 'keycode': e.detail, 'state': st, 'keysym': ks, 'char': keysym_char(ks),
                 'name': NAMES.get(ks)})
        elif e.type in (X.FocusIn, X.FocusOut):
            out({'ev': 'focus', 'in': e.type == X.FocusIn})
    r, _, _ = select.select([d.fileno(), 0], [], [], 0.2)
    if 0 not in r:
        continue
    chunk = sys.stdin.buffer.read1(4096) if hasattr(sys.stdin.buffer, 'read1') else b''
    if not chunk:
        break
    buf += chunk
    while b'\n' in buf:
        line, buf = buf.split(b'\n', 1)
        parts = line.decode().split()
        if not parts:
            continue
        c = parts[0]
        if c == 'getfocus':
            print('focus %d' % top_of(d.get_input_focus().focus), flush=True)
            continue
        if c == 'takefocus':
            w.set_input_focus(X.RevertToParent, X.CurrentTime)
        elif c == 'activate':
            ev = event.ClientMessage(window=w, client_type=A('_NET_ACTIVE_WINDOW'), data=(32, [1, X.CurrentTime, 0, 0, 0]))
            root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
        elif c == 'pointer':
            xtest.fake_input(d, X.MotionNotify, x=int(parts[1]), y=int(parts[2]))
        elif c == 'keys':
            codes = [d.keysym_to_keycode(XK.string_to_keysym(k)) for k in parts[1:]]
            for kc in codes:
                xtest.fake_input(d, X.KeyPress, kc)
            for kc in reversed(codes):
                xtest.fake_input(d, X.KeyRelease, kc)
        d.sync()
        print('ok', flush=True)
