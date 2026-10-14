#!/usr/bin/python3 -B
"""Drives the real aurora-xwm 'paste' command (XTest) against a small X client, for test/emoji.test.mjs.

    python3 -B xwm-paste.py <aurora-xwm path> [python-xlib dir]      (needs $DISPLAY, e.g. under xvfb-run)

Prints one JSON object: the 'paste' answers and the key presses the client received for each case.
The client ('win client') prints every KeyPress as "KEY <keysym> <state>"; 'win shell' stands for the shell window.
"""
import json
import os
import queue
import subprocess
import sys
import threading
import time

if len(sys.argv) > 2 and sys.argv[1] == 'win':
    if len(sys.argv) > 3:
        sys.path.insert(0, sys.argv[3])
    from Xlib import X, XK, display
    d = display.Display()
    s = d.screen()
    w = s.root.create_window(10, 10, 300, 200, 0, s.root_depth, X.InputOutput, X.CopyFromParent,
                             background_pixel=s.white_pixel, event_mask=X.KeyPressMask | X.StructureNotifyMask)
    w.set_wm_name(sys.argv[2])
    w.set_wm_class(sys.argv[2], sys.argv[2].capitalize())
    w.map()
    d.flush()
    print('XID', w.id, flush=True)
    while True:
        e = d.next_event()
        if e.type == X.KeyPress:
            ks = d.keycode_to_keysym(e.detail, 0)
            print('KEY', XK.keysym_to_string(ks) or hex(ks), e.state, flush=True)

HELPER = sys.argv[1]
LIB = sys.argv[2] if len(sys.argv) > 2 else None
if LIB:
    sys.path.insert(0, LIB)
from Xlib import X, XK, display  # noqa: E402
from Xlib.ext import xtest  # noqa: E402

queues = {}
procs = []


def pump(p):
    q = queues[p] = queue.Queue()
    threading.Thread(target=lambda: [q.put(l.strip()) for l in p.stdout], daemon=True).start()
    procs.append(p)
    return p


def start(args):
    return pump(subprocess.Popen([sys.executable, '-B'] + args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1))


def line(p, t=5.0):
    try:
        return queues[p].get(timeout=max(0.01, t))
    except queue.Empty:
        return None


me = os.path.abspath(__file__)
extra = [LIB] if LIB else []
out = {}
try:
    shell = start([me, 'win', 'shell'] + extra)
    sxid = int(line(shell).split()[1])
    runner = ("import sys\nif %r: sys.path.insert(0, %r)\nsys.argv = ['aurora-xwm', '--shell-xid', '%d']\n__name__ = '__main__'\n"
              "exec(compile(open(%r).read(), %r, 'exec'))" % (LIB, LIB, sxid, HELPER, HELPER))
    helper = pump(subprocess.Popen([sys.executable, '-B', '-c', runner], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1))

    def event(name, t=5.0):
        end = time.time() + t
        while time.time() < end:
            m = line(helper, end - time.time())
            if m:
                m = json.loads(m)
                if m.get('ev') == name:
                    return m
        return None

    def cmd(o):
        helper.stdin.write(json.dumps(o) + '\n')
        helper.stdin.flush()

    out['ready'] = event('ready') is not None
    client = start([me, 'win', 'client'] + extra)
    cxid = int(line(client).split()[1])
    new = event('new')
    out['managed'] = bool(new and new.get('id') == cxid)

    def keys(t=1.0):
        got, end = [], time.time() + t
        while time.time() < end:
            m = line(client, end - time.time())
            if m and m.startswith('KEY'):
                got.append(m[4:])
        return got

    cmd({'cmd': 'focus', 'id': cxid})
    time.sleep(0.3)
    for k in ('ctrl+v', 'ctrl+shift+v', 'shift+insert'):
        cmd({'cmd': 'paste', 'id': cxid, 'keys': k})
        out[k] = {'answer': event('paste'), 'keys': keys()}
    d = display.Display()
    shift = d.keysym_to_keycode(XK.XK_Shift_L)
    xtest.fake_input(d, X.KeyPress, shift)  # the user still holds Shift (Shift+click)
    d.sync()
    keys(0.3)
    cmd({'cmd': 'paste', 'id': cxid, 'keys': 'ctrl+v'})
    out['held-shift'] = {'answer': event('paste'), 'keys': keys()}
    km = d.query_keymap()
    out['held-shift']['still-down'] = bool(km[shift // 8] & (1 << (shift % 8)))
    xtest.fake_input(d, X.KeyRelease, shift)
    d.sync()
    cmd({'cmd': 'focus', 'id': None})
    time.sleep(0.3)
    cmd({'cmd': 'paste', 'id': cxid, 'keys': 'ctrl+v'})
    out['shell-focused'] = {'answer': event('paste'), 'keys': keys(0.6)}
    cmd({'cmd': 'paste', 'id': 12345, 'keys': 'ctrl+v'})
    out['unknown'] = event('paste')
finally:
    for p in procs:
        try:
            p.kill()
        except Exception:
            pass
print(json.dumps(out), flush=True)
