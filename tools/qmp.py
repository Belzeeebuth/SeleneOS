#!/usr/bin/env python3
"""Selene OS — small QMP / QEMU guest agent client for automated VM testing (stdlib only).

QMP (machine monitor, --sock work/qemu/aurora.qmp):
  qmp.py screendump out.png               save the screen as PNG
  qmp.py send-key ctrl-alt-f2 ret         press key combos (QEMU qcodes joined by '-')
  qmp.py type "hello world\\n"             type ASCII text (\\n = Enter, \\t = Tab)
  qmp.py mouse-move X Y                   move the absolute pointer (usb-tablet) to pixel X,Y
  qmp.py click X Y [left|right|middle]    move + click
  qmp.py wait-change [--timeout 120] [--threshold 0.01] [--save out.png]
                                          wait until the screen differs from now
  qmp.py wait-stable [--quiet-secs 10] [--timeout 300]   wait until the screen stops changing
  qmp.py status | powerdown | reset | quit | human "info block"
QEMU guest agent (--qga work/qemu/aurora.qga; needs qemu-guest-agent in the guest):
  qmp.py --qga SOCK ping
  qmp.py --qga SOCK exec [--timeout 60] -- nmcli -t dev     run a command as root, print output
  qmp.py --qga SOCK sh 'runuser -u aurora -- wpctl status'  run a shell command line
  qmp.py --qga SOCK push LOCAL REMOTE [--mode 755]          copy a file into the guest (as root)
  qmp.py --qga SOCK pull REMOTE LOCAL                       copy a file out of the guest
Exit status: 0 on success, 1 on error/timeout, the guest command's status for exec/sh.
"""
import argparse
import base64
import json
import os
import socket
import struct
import sys
import tempfile
import time
import zlib

# ---------------------------------------------------------------------------------------
# JSON line protocol
# ---------------------------------------------------------------------------------------


class Channel:
    def __init__(self, path, timeout=30):
        if not os.path.exists(path):
            raise SystemExit(f"qmp.py: socket {path} does not exist (is QEMU running?)")
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        self.sock.connect(path)
        self.buf = b""

    def send(self, obj):
        self.sock.sendall(json.dumps(obj).encode() + b"\n")

    def recv(self):
        while True:
            nl = self.buf.find(b"\n")
            if nl >= 0:
                line, self.buf = self.buf[:nl], self.buf[nl + 1:]
                line = line.strip()
                if not line:
                    continue
                # The guest agent may emit a 0xff sentinel after guest-sync-delimited.
                line = line.lstrip(b"\xff")
                return json.loads(line)
            chunk = self.sock.recv(65536)
            if not chunk:
                raise SystemExit("qmp.py: connection closed")
            self.buf += chunk

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class QMP(Channel):
    def __init__(self, path, timeout=30):
        super().__init__(path, timeout)
        greeting = self.recv()
        if "QMP" not in greeting:
            raise SystemExit(f"qmp.py: unexpected greeting {greeting}")
        self.execute("qmp_capabilities")

    def execute(self, cmd, args=None):
        msg = {"execute": cmd}
        if args:
            msg["arguments"] = args
        self.send(msg)
        while True:
            r = self.recv()
            if "event" in r:
                continue
            if "error" in r:
                raise RuntimeError(f"{cmd}: {r['error'].get('desc', r['error'])}")
            return r.get("return")


class QGA(Channel):
    def __init__(self, path, timeout=30):
        super().__init__(path, timeout)
        sync_id = int(time.time() * 1000) % 2**31
        self.send({"execute": "guest-sync", "arguments": {"id": sync_id}})
        deadline = time.time() + timeout
        while time.time() < deadline:
            r = self.recv()
            if r.get("return") == sync_id:
                return
        raise SystemExit("qmp.py: guest agent did not answer guest-sync")

    def execute(self, cmd, args=None):
        msg = {"execute": cmd}
        if args:
            msg["arguments"] = args
        self.send(msg)
        r = self.recv()
        if "error" in r:
            raise RuntimeError(f"{cmd}: {r['error'].get('desc', r['error'])}")
        return r.get("return")


# ---------------------------------------------------------------------------------------
# images
# ---------------------------------------------------------------------------------------


def read_ppm(path):
    with open(path, "rb") as f:
        data = f.read()
    # P6 <w> <h> <maxval> <binary>
    parts, pos = [], 0
    while len(parts) < 4:
        while data[pos:pos + 1].isspace():
            pos += 1
        if data[pos:pos + 1] == b"#":
            pos = data.index(b"\n", pos) + 1
            continue
        end = pos
        while not data[end:end + 1].isspace():
            end += 1
        parts.append(data[pos:end])
        pos = end
    if parts[0] != b"P6":
        raise SystemExit("qmp.py: screendump is not a binary PPM")
    w, h = int(parts[1]), int(parts[2])
    return w, h, data[pos + 1:pos + 1 + w * h * 3]


def write_png(path, w, h, rgb):
    def chunk(tag, payload):
        c = struct.pack(">I", len(payload)) + tag + payload
        return c + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)

    stride = w * 3
    raw = b"".join(b"\x00" + rgb[y * stride:(y + 1) * stride] for y in range(h))
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    tmp = f"{path}.tmp"
    with open(tmp, "wb") as f:
        f.write(png)
    os.replace(tmp, path)


def grab(q):
    """Return (w, h, rgb bytes) of the current screen."""
    fd, tmp = tempfile.mkstemp(suffix=".ppm", prefix="qmp-")
    os.close(fd)
    try:
        q.execute("screendump", {"filename": tmp})
        return read_ppm(tmp)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def screendump(q, out):
    w, h, rgb = grab(q)
    write_png(out, w, h, rgb)
    return w, h


def diff_ratio(a, b, step=7):
    """Fraction of sampled pixels that differ between two RGB buffers."""
    if a is None or b is None or len(a) != len(b):
        return 1.0
    n = len(a) // 3
    if n == 0:
        return 0.0
    changed = total = 0
    for i in range(0, n, step):
        o = i * 3
        total += 1
        if a[o:o + 3] != b[o:o + 3]:
            changed += 1
    return changed / total


# ---------------------------------------------------------------------------------------
# keyboard / mouse
# ---------------------------------------------------------------------------------------

SHIFTED = {
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
    "_": "minus", "+": "equal", "{": "bracket_left", "}": "bracket_right", "|": "backslash",
    ":": "semicolon", '"': "apostrophe", "~": "grave_accent", "<": "comma", ">": "dot", "?": "slash",
}
PLAIN = {
    " ": "spc", "-": "minus", "=": "equal", "[": "bracket_left", "]": "bracket_right", "\\": "backslash",
    ";": "semicolon", "'": "apostrophe", "`": "grave_accent", ",": "comma", ".": "dot", "/": "slash",
    "\n": "ret", "\t": "tab", "\b": "backspace",
}
ALIASES = {
    "enter": "ret", "return": "ret", "esc": "esc", "escape": "esc", "space": "spc", "win": "meta_l",
    "super": "meta_l", "meta": "meta_l", "ctrl": "ctrl", "control": "ctrl", "alt": "alt", "shift": "shift",
    "del": "delete", "pgup": "pgup", "pgdn": "pgdn", "bksp": "backspace",
}


def qcode(name):
    name = ALIASES.get(name.lower(), name.lower())
    return {"type": "qcode", "data": name}


def char_keys(ch):
    """Return the list of qcodes (US layout) to type one ASCII character."""
    if ch.isalpha() and ch.isascii():
        return (["shift"] if ch.isupper() else []) + [ch.lower()]
    if ch.isdigit():
        return [ch]
    if ch in PLAIN:
        return [PLAIN[ch]]
    if ch in SHIFTED:
        return ["shift", SHIFTED[ch]]
    raise SystemExit(f"qmp.py: cannot type {ch!r} (ASCII only)")


def send_combo(q, combo, hold_ms=60):
    keys = [qcode(k) for k in combo.split("-") if k] if combo != "-" else [qcode("minus")]
    q.execute("send-key", {"keys": keys, "hold-time": hold_ms})


def type_text(q, text, delay=0.04):
    for ch in text:
        q.execute("send-key", {"keys": [qcode(k) for k in char_keys(ch)], "hold-time": 30})
        time.sleep(delay)


def screen_size(q):
    w, h, _ = grab(q)
    return w, h


def mouse_move(q, x, y, size=None):
    w, h = size or screen_size(q)
    ax = max(0, min(32767, round(x * 32767 / max(1, w - 1))))
    ay = max(0, min(32767, round(y * 32767 / max(1, h - 1))))
    q.execute("input-send-event", {"events": [
        {"type": "abs", "data": {"axis": "x", "value": ax}},
        {"type": "abs", "data": {"axis": "y", "value": ay}},
    ]})


def mouse_click(q, x, y, button="left"):
    size = screen_size(q)
    mouse_move(q, x, y, size)
    time.sleep(0.05)
    for down in (True, False):
        q.execute("input-send-event", {"events": [{"type": "btn", "data": {"down": down, "button": button}}]})
        time.sleep(0.08)


# ---------------------------------------------------------------------------------------
# guest agent
# ---------------------------------------------------------------------------------------


def guest_push(g, local, remote, mode=None):
    with open(local, "rb") as f:
        data = f.read()
    h = g.execute("guest-file-open", {"path": remote, "mode": "wb"})
    try:
        for off in range(0, len(data), 48 * 1024):
            g.execute("guest-file-write", {"handle": h, "buf-b64": base64.b64encode(data[off:off + 48 * 1024]).decode()})
    finally:
        g.execute("guest-file-close", {"handle": h})
    if mode:
        guest_exec(g, ["/bin/chmod", mode, remote])
    return len(data)


def guest_pull(g, remote, local):
    h = g.execute("guest-file-open", {"path": remote, "mode": "rb"})
    chunks = []
    try:
        while True:
            r = g.execute("guest-file-read", {"handle": h, "count": 48 * 1024})
            chunks.append(base64.b64decode(r.get("buf-b64", "")))
            if r.get("eof"):
                break
    finally:
        g.execute("guest-file-close", {"handle": h})
    with open(local, "wb") as f:
        f.write(b"".join(chunks))
    return sum(len(c) for c in chunks)


def guest_exec(g, argv, timeout=60, env=None):
    args = {"path": argv[0], "arg": argv[1:], "capture-output": True}
    if env:
        args["env"] = env
    pid = g.execute("guest-exec", args)["pid"]
    deadline = time.time() + timeout
    while True:
        st = g.execute("guest-exec-status", {"pid": pid})
        if st.get("exited"):
            out = base64.b64decode(st.get("out-data", "")).decode(errors="replace")
            err = base64.b64decode(st.get("err-data", "")).decode(errors="replace")
            code = st.get("exitcode", 128 + st.get("signal", 0))
            return code, out, err
        if time.time() > deadline:
            raise SystemExit(f"qmp.py: guest command timed out after {timeout}s: {' '.join(argv)}")
        time.sleep(0.3)


# ---------------------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------------------


def default_sock(ext):
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "..", "work", "qemu", f"aurora.{ext}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sock", default=os.environ.get("QMP_SOCK", default_sock("qmp")), help="QMP socket")
    ap.add_argument("--qga", nargs="?", const=os.environ.get("QGA_SOCK", default_sock("qga")), default=None,
                    help="talk to the guest agent socket instead of QMP")
    ap.add_argument("--timeout", type=float, default=30, help="socket timeout (s)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("screendump"); p.add_argument("out")
    p = sub.add_parser("send-key"); p.add_argument("combos", nargs="+"); p.add_argument("--hold", type=int, default=60)
    p = sub.add_parser("type"); p.add_argument("text"); p.add_argument("--delay", type=float, default=0.04)
    p = sub.add_parser("mouse-move"); p.add_argument("x", type=int); p.add_argument("y", type=int)
    p = sub.add_parser("click"); p.add_argument("x", type=int); p.add_argument("y", type=int)
    p.add_argument("button", nargs="?", default="left", choices=["left", "right", "middle"])
    p = sub.add_parser("wait-change")
    p.add_argument("--timeout", dest="wait_timeout", type=float, default=120)
    p.add_argument("--threshold", type=float, default=0.01)
    p.add_argument("--interval", type=float, default=2)
    p.add_argument("--save")
    p = sub.add_parser("wait-stable")
    p.add_argument("--quiet-secs", type=float, default=10)
    p.add_argument("--timeout", dest="wait_timeout", type=float, default=300)
    p.add_argument("--threshold", type=float, default=0.002)
    p.add_argument("--interval", type=float, default=2)
    p.add_argument("--save")
    sub.add_parser("status"); sub.add_parser("powerdown"); sub.add_parser("reset"); sub.add_parser("quit")
    p = sub.add_parser("human"); p.add_argument("command")
    sub.add_parser("ping")
    p = sub.add_parser("exec"); p.add_argument("argv", nargs="+")
    p.add_argument("--timeout", dest="exec_timeout", type=float, default=60)
    p = sub.add_parser("push"); p.add_argument("local"); p.add_argument("remote"); p.add_argument("--mode")
    p = sub.add_parser("pull"); p.add_argument("remote"); p.add_argument("local")
    p = sub.add_parser("sh"); p.add_argument("script")
    p.add_argument("--timeout", dest="exec_timeout", type=float, default=60)
    a = ap.parse_args()

    # Guest agent commands
    if a.cmd in ("ping", "exec", "sh", "push", "pull"):
        sock = a.qga or os.environ.get("QGA_SOCK", default_sock("qga"))
        g = QGA(sock, a.timeout)
        if a.cmd == "ping":
            g.execute("guest-ping")
            info = g.execute("guest-info")
            print(f"guest agent {info.get('version', '?')} is alive")
            return 0
        if a.cmd == "push":
            print(f"{guest_push(g, a.local, a.remote, a.mode)} bytes -> {a.remote}")
            return 0
        if a.cmd == "pull":
            print(f"{guest_pull(g, a.remote, a.local)} bytes -> {a.local}")
            return 0
        argv = a.argv if a.cmd == "exec" else ["/bin/sh", "-c", a.script]
        code, out, err = guest_exec(g, argv, a.exec_timeout)
        sys.stdout.write(out)
        sys.stderr.write(err)
        return code

    q = QMP(a.sock, a.timeout)
    if a.cmd == "screendump":
        w, h = screendump(q, a.out)
        print(f"{a.out} {w}x{h}")
    elif a.cmd == "send-key":
        for c in a.combos:
            send_combo(q, c, a.hold)
            time.sleep(0.1)
    elif a.cmd == "type":
        type_text(q, a.text.encode().decode("unicode_escape"), a.delay)
    elif a.cmd == "mouse-move":
        mouse_move(q, a.x, a.y)
    elif a.cmd == "click":
        mouse_click(q, a.x, a.y, a.button)
    elif a.cmd == "wait-change":
        _, _, base = grab(q)
        deadline = time.time() + a.wait_timeout
        while time.time() < deadline:
            time.sleep(a.interval)
            w, h, cur = grab(q)
            r = diff_ratio(base, cur)
            if r >= a.threshold:
                if a.save:
                    write_png(a.save, w, h, cur)
                print(f"screen changed ({r:.1%} of pixels)")
                return 0
        print("timeout: screen did not change", file=sys.stderr)
        return 1
    elif a.cmd == "wait-stable":
        deadline = time.time() + a.wait_timeout
        w, h, prev = grab(q)
        quiet_since = time.time()
        while time.time() < deadline:
            time.sleep(a.interval)
            w, h, cur = grab(q)
            if diff_ratio(prev, cur) > a.threshold:
                quiet_since = time.time()
            prev = cur
            if time.time() - quiet_since >= a.quiet_secs:
                if a.save:
                    write_png(a.save, w, h, cur)
                print(f"screen stable for {a.quiet_secs:.0f}s")
                return 0
        print("timeout: screen kept changing", file=sys.stderr)
        return 1
    elif a.cmd == "status":
        print(json.dumps(q.execute("query-status")))
    elif a.cmd == "powerdown":
        q.execute("system_powerdown")
    elif a.cmd == "reset":
        q.execute("system_reset")
    elif a.cmd == "quit":
        q.execute("quit")
    elif a.cmd == "human":
        print(q.execute("human-monitor-command", {"command-line": a.command}), end="")
    q.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as e:
        print(f"qmp.py: {e}", file=sys.stderr)
        sys.exit(1)
    except (socket.timeout, ConnectionError) as e:
        print(f"qmp.py: {e}", file=sys.stderr)
        sys.exit(1)
