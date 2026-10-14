#!/usr/bin/env python3
# X input / shape helper for test/magnifier.test.mjs (python3-xlib, XTest and SHAPE; no root, display from $DISPLAY).
#
#   xctl.py move X Y                      pointer to (X, Y) on the root
#   xctl.py click X Y [BUTTON]            move there, press and release BUTTON (default 1)
#   xctl.py wheel X Y up|down [KEYSYM..]  move there, hold the modifier keys (e.g. Control_L Alt_L), one wheel step
#   xctl.py key KEYSYM [KEYSYM..]         press the keys in order, release them in reverse (Super_L equal)
#   xctl.py input XID                     JSON [[x, y, w, h], ...]: the window's input shape
#   xctl.py bounding XID                  JSON: its bounding shape
#   xctl.py pointer                       JSON [x, y]
import json
import sys

from Xlib import X, XK, display
from Xlib.ext import shape, xtest


def main(argv):
    d = display.Display()
    cmd = argv[1]

    def move(x, y):
        xtest.fake_input(d, X.MotionNotify, x=int(x), y=int(y))
        d.sync()

    def keycode(name):
        kc = d.keysym_to_keycode(XK.string_to_keysym(name))
        if not kc:
            raise SystemExit('no keycode for %s' % name)
        return kc

    if cmd == 'move':
        move(argv[2], argv[3])
    elif cmd == 'click':
        move(argv[2], argv[3])
        b = int(argv[4]) if len(argv) > 4 else 1
        xtest.fake_input(d, X.ButtonPress, b)
        d.sync()
        xtest.fake_input(d, X.ButtonRelease, b)
        d.sync()
    elif cmd == 'wheel':
        move(argv[2], argv[3])
        mods = [keycode(n) for n in argv[5:]]
        for kc in mods:
            xtest.fake_input(d, X.KeyPress, kc)
        d.sync()
        b = 4 if argv[4] == 'up' else 5
        xtest.fake_input(d, X.ButtonPress, b)
        xtest.fake_input(d, X.ButtonRelease, b)
        d.sync()
        for kc in reversed(mods):
            xtest.fake_input(d, X.KeyRelease, kc)
        d.sync()
    elif cmd == 'key':
        codes = [keycode(n) for n in argv[2:]]
        for kc in codes:
            xtest.fake_input(d, X.KeyPress, kc)
            d.sync()
        for kc in reversed(codes):
            xtest.fake_input(d, X.KeyRelease, kc)
            d.sync()
    elif cmd in ('input', 'bounding'):
        w = d.create_resource_object('window', int(argv[2]))
        kind = shape.SK.Input if cmd == 'input' else shape.SK.Bounding
        r = w.shape_get_rectangles(kind)
        print(json.dumps([[q.x, q.y, q.width, q.height] for q in r.rectangles]))
    elif cmd == 'pointer':
        p = d.screen().root.query_pointer()
        print(json.dumps([p.root_x, p.root_y]))
    else:
        raise SystemExit('unknown command %s' % cmd)
    d.sync()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
