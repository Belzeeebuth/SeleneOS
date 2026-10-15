#!/usr/bin/env bash
# Selene OS — runtime smoke test of the built image, without a virtual machine.
#
#   sudo tools/smoke-image.sh                 test the newest out/selene-os-*.iso
#   sudo tools/smoke-image.sh --iso PATH      test another ISO
#   sudo tools/smoke-image.sh --squashfs work/iso/casper/filesystem.squashfs
#   options: --secs N (time each mode keeps running, default 20)  --ready-timeout N (default 90)
#            --logs DIR (default work/smoke-logs)
#
# What it does: mounts the image's casper/filesystem.squashfs (exactly what the ISO ships)
# read-only under a throwaway tmpfs overlay, starts a private Xvfb on the host and runs the
# image's own launchers (/usr/bin/aurora-shell, /usr/lib/aurora/aurora-xgreeter: the shipped
# Electron + /opt/aurora/shell) as an unprivileged test user created for the test only.
# Checks:
#   - ldd: no missing shared library for Electron and its bundled libraries
#   - shell mode:   the renderer reaches body.ready (DevTools protocol) and the window covers
#                   the whole screen
#   - greeter mode: greeter.html loads (body.ready reported when the page sets it)
#   - stderr of both runs: no "error while loading shared libraries" / FATAL / crash
# Electron runs with --no-sandbox here (a build container is not a booted system); the real
# session keeps the sandbox. Everything is unmounted afterwards and /proc/mounts is checked.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
NODE_BIN="${NODE_BIN:-/opt/node22/bin}"
NODE="$NODE_BIN/node"; [[ -x "$NODE" ]] || NODE="$(command -v node || true)"

ISO=""
SQUASHFS=""
SECS=20
READY_TIMEOUT=90
LOGS="$ROOT/work/smoke-logs"
TEST_USER="aurora-smoke"

die()  { echo "smoke-image: error: $*" >&2; exit 1; }
log()  { echo "smoke-image: $*" >&2; }
usage() { sed -n '2,/^set -E/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --iso) ISO="${2:?}"; shift 2 ;;
    --squashfs) SQUASHFS="${2:?}"; shift 2 ;;
    --secs) SECS="${2:?}"; shift 2 ;;
    --ready-timeout) READY_TIMEOUT="${2:?}"; shift 2 ;;
    --logs) LOGS="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root (mounts, chroot): sudo $0"
# Commands run inside the image (chroot) search this PATH: Ubuntu keeps useradd, usermod, apparmor_parser… in /usr/sbin,
# which hosts that merged sbin into bin (Arch, CachyOS) leave out of PATH.
for d in /usr/local/sbin /usr/sbin /sbin; do [[ ":$PATH:" == *":$d:"* ]] || PATH="$PATH:$d"; done
export PATH
for t in Xvfb mount umount losetup chroot setsid findmnt python3; do
  command -v "$t" >/dev/null 2>&1 || die "$t is required (Ubuntu: apt-get install xvfb util-linux python3; Arch / CachyOS: pacman -S xorg-server-xvfb util-linux python)"
done
[[ -n "$NODE" && -x "$NODE" ]] || die "node (22+) is required for the DevTools probe (set NODE_BIN)"
"$NODE" -e 'if (typeof WebSocket !== "function") process.exit(1)' || die "node $("$NODE" --version) has no WebSocket (need node 22+)"

if [[ -z "$SQUASHFS" ]]; then
  if [[ -z "$ISO" ]]; then
    ISO="$(find "$ROOT/out" -maxdepth 1 -name 'selene-os-*.iso' -printf '%T@ %p\n' 2>/dev/null | sort -rn | sed -n '1s/^[^ ]* //p')"
  fi
  [[ -n "$ISO" && -f "$ISO" ]] || die "no ISO found (make iso, or pass --iso / --squashfs)"
  ISO="$(readlink -f "$ISO")"
else
  SQUASHFS="$(readlink -f "$SQUASHFS")"
  [[ -f "$SQUASHFS" ]] || die "$SQUASHFS not found"
fi

mkdir -p "$ROOT/work" "$LOGS"
T="$(mktemp -d "$ROOT/work/smoke.XXXXXX")"
R="$T/root"
XVFB_PID=""
APP_PGID=""

umount_under() { # unmount everything below $1, deepest first
  local base="$1" mp
  while read -r mp; do
    [[ -n "$mp" ]] || continue
    umount "$mp" 2>/dev/null || umount -l "$mp" 2>/dev/null || log "warning: could not unmount $mp"
  done < <(findmnt -rn -o TARGET | awk -v b="$base" '$0 == b || index($0, b "/") == 1' | sort -r)
}

stop_app() {
  if [[ -n "$APP_PGID" ]]; then
    kill -TERM -- "-$APP_PGID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- "-$APP_PGID" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$APP_PGID" 2>/dev/null || true
    APP_PGID=""
  fi
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  stop_app
  if [[ -n "$XVFB_PID" ]]; then kill "$XVFB_PID" 2>/dev/null || true; wait "$XVFB_PID" 2>/dev/null || true; fi
  if [[ -d "$R/etc" ]] && chroot "$R" getent passwd "$TEST_USER" >/dev/null 2>&1; then
    chroot "$R" userdel -r "$TEST_USER" >/dev/null 2>&1 || log "warning: userdel $TEST_USER failed"
  fi
  umount_under "$T"
  if findmnt -rn -o TARGET | grep -qF "$T"; then
    log "ERROR: mounts left under $T:"; findmnt -rn -o TARGET | grep -F "$T" >&2; rc=1
  else
    rm -rf "$T"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- mount the image ---------------------------------------------------------------------
mkdir -p "$T/iso" "$T/rofs" "$T/rw" "$R"
if [[ -n "$ISO" ]]; then
  log "image: $ISO"
  # Loop-mount the ISO; kernels without iso9660 (some containers) get the squashfs extracted.
  if mount -o loop,ro "$ISO" "$T/iso" 2>/dev/null; then
    SQUASHFS="$T/iso/casper/filesystem.squashfs"
  else
    log "cannot mount iso9660 here: extracting casper/filesystem.squashfs with xorriso"
    command -v xorriso >/dev/null 2>&1 || die "xorriso is required to read the ISO"
    xorriso -osirrox on -indev "$ISO" -extract /casper/filesystem.squashfs "$T/filesystem.squashfs" >/dev/null 2>&1 \
      || die "cannot extract casper/filesystem.squashfs from $ISO"
    SQUASHFS="$T/filesystem.squashfs"
  fi
  [[ -f "$SQUASHFS" ]] || die "$ISO has no casper/filesystem.squashfs"
else
  log "image: $SQUASHFS"
fi
mount -t squashfs -o loop,ro "$SQUASHFS" "$T/rofs"
mount -t tmpfs -o mode=0755,size=2g tmpfs "$T/rw"
mkdir -p "$T/rw/upper" "$T/rw/work"
mount -t overlay overlay -o "lowerdir=$T/rofs,upperdir=$T/rw/upper,workdir=$T/rw/work" "$R"
mount -t proc proc "$R/proc"
mount -t sysfs sysfs "$R/sys"
mount --bind /dev "$R/dev"
mount --bind /dev/pts "$R/dev/pts"
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$R/dev/shm"
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs "$R/run"
rm -f "$R/etc/resolv.conf"; : >"$R/etc/resolv.conf"   # no network needed

log "build id: $(cat "$R/etc/aurora/build-id" 2>/dev/null || echo '?')  electron: $(cat "$R/opt/aurora/electron/version.aurora" 2>/dev/null || echo '?')"

FAIL=0
WARNED=0
fail() { log "FAIL: $*"; FAIL=1; }
pass() { log "PASS: $*"; }

# ---- shared libraries ----------------------------------------------------------------------
nf="$(chroot "$R" /bin/sh -c 'for f in /opt/aurora/electron/electron /opt/aurora/electron/chrome_crashpad_handler \
        /opt/aurora/electron/*.so /opt/aurora/electron/*.so.*; do [ -f "$f" ] && ldd "$f" 2>&1 | sed "s|^|$f: |"; done' \
      | grep 'not found' || true)"
if [[ -z "$nf" ]]; then pass "ldd: every Electron binary/library resolves its shared libraries"
else fail "missing shared libraries:"; echo "$nf" >&2; fi
native="$(find "$R/opt/aurora/shell/node_modules" -name '*.node' -type f 2>/dev/null | sed "s|^$R||")"
for f in $native; do
  if chroot "$R" ldd "$f" 2>&1 | grep -q 'not found'; then fail "native module $f misses libraries"; fi
done

# ---- test user + X server ------------------------------------------------------------------
chroot "$R" useradd -m -s /bin/bash -c "Selene smoke test" "$TEST_USER"
chroot "$R" usermod -a -G video,audio "$TEST_USER" 2>/dev/null || true
TUID="$(chroot "$R" id -u "$TEST_USER")"
install -d -m 0700 -o "$TUID" -g "$TUID" "$R/run/user/$TUID"
log "test user $TEST_USER (uid $TUID) created in the throwaway overlay"

SCREEN=1600x900
DNUM=90
while [[ -e "/tmp/.X$DNUM-lock" || -S "/tmp/.X11-unix/X$DNUM" ]]; do DNUM=$((DNUM + 1)); done
Xvfb ":$DNUM" -screen 0 "${SCREEN}x24" -nolisten tcp -ac >"$LOGS/xvfb.log" 2>&1 &
XVFB_PID=$!
for _ in $(seq 1 50); do [[ -S "/tmp/.X11-unix/X$DNUM" ]] && break; sleep 0.2; done
[[ -S "/tmp/.X11-unix/X$DNUM" ]] || die "Xvfb :$DNUM did not start (see $LOGS/xvfb.log)"
mkdir -p "$R/tmp/.X11-unix"
mount --bind /tmp/.X11-unix "$R/tmp/.X11-unix"
log "Xvfb :$DNUM ($SCREEN) shared with the image through /tmp/.X11-unix"

free_port() { python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }

# DevTools probe: waits for the page, then for body.ready; prints a JSON report.
cat >"$T/cdp-probe.mjs" <<'JS'
const [port, page, timeoutMs, needReady] = process.argv.slice(2);
const deadline = Date.now() + Number(timeoutMs);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { ok: false, page, target: null, state: null, exceptions: [] };
let target = null, targets = null;
while (Date.now() < deadline && !target) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { targets = null; }
  target = targets?.find((t) => t.type === 'page' && t.url.includes(page)) || null;
  if (!target) await sleep(500);
}
if (!target) {
  out.reason = 'no DevTools page target for ' + page;
  out.targets = (targets || []).map((t) => `${t.type} ${t.url}`);
  console.log(JSON.stringify(out, null, 1));
  process.exit(2);
}
out.target = target.url;
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('websocket error')); });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    out.exceptions.push((d.exception && d.exception.description || d.text || '').split('\n')[0]);
  }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
const expr = `JSON.stringify({ href: location.href, readyState: document.readyState, title: document.title,
  ready: !!(document.body && document.body.classList.contains('ready')), bodyClass: document.body ? document.body.className : null,
  elements: document.getElementsByTagName('*').length, size: innerWidth + 'x' + innerHeight })`;
while (Date.now() < deadline) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  try { out.state = JSON.parse(r.result.result.value); } catch { out.state = null; }
  if (out.state && out.state.readyState === 'complete' && (out.state.ready || needReady !== '1')) break;
  await sleep(500);
}
out.ok = !!(out.state && out.state.readyState === 'complete' && (needReady !== '1' || out.state.ready));
if (needReady !== '1' && out.state && !out.state.ready) {
  // Give pages without a ready marker a moment to settle, then report what they show.
  await sleep(2000);
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  try { out.state = JSON.parse(r.result.result.value); } catch {}
}
ws.close();
console.log(JSON.stringify(out, null, 1));
process.exit(out.ok ? 0 : 3);
JS

# run_mode NAME LAUNCHER PAGE NEED_READY: start, probe, keep running SECS, stop, scan stderr.
run_mode() {
  local name="$1" launcher="$2" page="$3" need_ready="$4" port log t0 probe rc=0
  port="$(free_port)"
  log="$LOGS/$name.log"
  log "[$name] starting $launcher as $TEST_USER (DevTools port $port), running ${SECS}s"
  t0=$(date +%s)
  setsid chroot --userspec="$TEST_USER:$TEST_USER" "$R" /usr/bin/env -i \
      HOME="/home/$TEST_USER" USER="$TEST_USER" LOGNAME="$TEST_USER" SHELL=/bin/bash \
      PATH=/usr/local/bin:/usr/bin:/bin LANG=en_US.UTF-8 \
      DISPLAY=":$DNUM" XDG_RUNTIME_DIR="/run/user/$TUID" XDG_SESSION_TYPE=x11 \
      AURORA_GPU=off AURORA_GREETER_DATA="/home/$TEST_USER/greeter-data" \
      AURORA_ELECTRON_FLAGS="--no-sandbox --remote-debugging-port=$port --remote-allow-origins=*" \
      dbus-run-session -- "$launcher" >"$log" 2>&1 &
  APP_PGID=$!
  probe="$("$NODE" "$T/cdp-probe.mjs" "$port" "$page" "$((READY_TIMEOUT * 1000))" "$need_ready")" || rc=$?
  echo "$probe" >"$LOGS/$name.probe.json"
  local waited=$(( $(date +%s) - t0 ))
  if ((rc == 0)); then
    pass "[$name] $(sed -n 's/.*"href": "\([^"]*\)".*/\1/p' <<<"$probe" | head -n1) loaded in ${waited}s ($(grep -o '"ready": [a-z]*' <<<"$probe" | head -n1), $(grep -o '"size": "[^"]*"' <<<"$probe" | head -n1))"
  else
    fail "[$name] renderer check failed (exit $rc):"; echo "$probe" >&2
  fi
  local size; size="$(sed -n 's/.*"size": "\([^"]*\)".*/\1/p' <<<"$probe" | head -n1)"
  if [[ "$size" == "$SCREEN" ]]; then pass "[$name] the window covers the whole screen ($size)"
  elif [[ -n "$size" ]]; then fail "[$name] window is $size, the screen is $SCREEN"; fi
  local left=$(( SECS - waited ))
  ((left > 0)) && sleep "$left"
  kill -0 -- "-$APP_PGID" 2>/dev/null || fail "[$name] the app exited early (see $log)"
  local before; before="$(wc -l <"$log")"
  stop_app
  # The whole process group gets SIGTERM at once, so the GPU process can die before the browser process; Chromium
  # then fails to relaunch it and logs "GPU process isn't usable" while quitting. Only that one shutdown message is
  # tolerated, and only after the stop signal.
  local bad
  bad="$( { head -n "$before" "$log"; tail -n +"$((before + 1))" "$log" | grep -v 'GPU process isn.t usable'; } \
    | grep -E 'error while loading shared libraries|cannot open shared object|FATAL:|Segmentation fault|Trace/breakpoint trap|core dumped' || true)"
  if [[ -n "$bad" ]]; then fail "[$name] fatal messages on stderr:"; echo "$bad" >&2
  else pass "[$name] stderr has no missing-library/fatal/crash messages ($(wc -l <"$log") lines, log: $log)"; fi
  grep -q '"exceptions": \[\]' "$LOGS/$name.probe.json" \
    || log "[$name] note: uncaught renderer exceptions were reported (see $LOGS/$name.probe.json)"
}

run_mode shell /usr/bin/aurora-shell shell.html 1
if [[ ! -f "$R/opt/aurora/shell/renderer/greeter.html" ]]; then
  log "WARNING: /opt/aurora/shell/renderer/greeter.html is not in the image yet: the greeter launcher"
  log "         (X setup + Electron in greeter mode) is still tested, its page is the 404 placeholder"
  WARNED=1
fi
run_mode greeter /usr/lib/aurora/aurora-xgreeter greeter.html 0

chroot "$R" userdel -r "$TEST_USER" >/dev/null 2>&1 && log "test user $TEST_USER removed"
if ((FAIL)); then log "RESULT: FAILED (logs in $LOGS)"; exit 1; fi
if ((WARNED)); then log "RESULT: passed with warnings (logs in $LOGS)"; else log "RESULT: all checks passed (logs in $LOGS)"; fi
