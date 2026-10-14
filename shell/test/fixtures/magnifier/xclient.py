#!/usr/bin/env python3
# Test X11 client for test/magnifier.test.mjs (python3-xlib only, no toolkit).
#
#   xclient.py --log FILE [--size 400x300] [--name MagClient]
#
# Maps one top-level window filled with a 4 x 4 grid of known colours (cell (col, row) is
# rgb(40 + 50*col, 40 + 50*row, 200)), so a picture of the window can be checked pixel by pixel,
# and appends one JSON line per button press to FILE: {"ev": "press", "x", "y", "button", "rx", "ry"}
# (x / y in the window, rx / ry on the root). Prints {"ev": "ready", "id": XID} on stdout once mapped.
import json
import sys

from Xlib import X, Xatom, display


def arg(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def color(col, row):
    return (40 + 50 * col, 40 + 50 * row, 200)


def main():
    log_path = arg('--log')
    w, h = (int(v) for v in arg('--size', '400x300').split('x'))
    name = arg('--name', 'MagClient')
    d = display.Display()
    screen = d.screen()
    win = screen.root.create_window(
        0, 0, w, h, 0, screen.root_depth, X.InputOutput, X.CopyFromParent,
        background_pixel=screen.white_pixel,
        event_mask=X.ExposureMask | X.ButtonPressMask | X.StructureNotifyMask | X.KeyPressMask)
    win.set_wm_name(name)
    win.set_wm_class(name.lower(), name)
    win.change_property(d.intern_atom('_NET_WM_NAME'), d.intern_atom('UTF8_STRING'), 8, name.encode())
    win.set_wm_protocols([d.intern_atom('WM_DELETE_WINDOW')])
    win.change_property(d.intern_atom('_NET_WM_PID'), Xatom.CARDINAL, 32, [__import__('os').getpid()])
    gc = win.create_gc()
    size = [w, h]

    def draw():
        cw, ch = size[0] / 4.0, size[1] / 4.0
        for col in range(4):
            for row in range(4):
                r, g, b = color(col, row)
                gc.change(foreground=(r << 16) | (g << 8) | b)
                x0, y0 = int(round(col * cw)), int(round(row * ch))
                x1, y1 = int(round((col + 1) * cw)), int(round((row + 1) * ch))
                win.fill_rectangle(gc, x0, y0, x1 - x0, y1 - y0)
        d.flush()

    win.map()
    d.flush()
    mapped = False
    out = open(log_path, 'a') if log_path else None
    while True:
        e = d.next_event()
        if e.type == X.MapNotify and not mapped:
            mapped = True
            print(json.dumps({'ev': 'ready', 'id': win.id}), flush=True)
        elif e.type == X.Expose and e.count == 0:
            draw()
        elif e.type == X.ConfigureNotify:
            if (e.width, e.height) != tuple(size):
                size[0], size[1] = e.width, e.height
                draw()
        elif e.type == X.ButtonPress:
            if out:
                out.write(json.dumps({'ev': 'press', 'x': e.event_x, 'y': e.event_y, 'button': e.detail,
                                      'rx': e.root_x, 'ry': e.root_y}) + '\n')
                out.flush()
        elif e.type == X.ClientMessage:
            if e.client_type == d.intern_atom('WM_PROTOCOLS'):
                return 0
        elif e.type == X.DestroyNotify:
            return 0


if __name__ == '__main__':
    sys.exit(main())
