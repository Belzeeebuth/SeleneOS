#!/usr/bin/env bash
# shellcheck disable=SC2054  # QEMU option values contain commas
# Aurora OS — QEMU launcher for the live ISO and for installed virtual disks.
#
#   tools/qemu-run.sh                    live session from the newest out/aurora-os-*.iso (BIOS),
#                                        with a 32G virtual disk to install to (created if missing)
#   tools/qemu-run.sh --uefi             same with UEFI firmware (OVMF)
#   tools/qemu-run.sh --boot disk        boot the installed disk only (add --uefi if it was
#                                        installed in UEFI mode)
#   tools/qemu-run.sh --dry-run          print the commands (qemu-img, qemu-system-x86_64) and exit
#
# Boot order (--boot):
#   auto  (default with an ISO) virtual disk first, then the CD. Firmware skips a blank disk, so
#         the first boot starts the live ISO (install from there); once Aurora OS is installed
#         the VM boots the disk even though the ISO is still attached: a "boot once from CD".
#   cd    CD first (to use the live session again with an installed disk)
#   disk  installed disk only, no ISO attached
#
# Options (environment variables in brackets):
#   --iso PATH           ISO to boot [ISO]               (default: newest out/aurora-os-*.iso)
#   --disk PATH          qcow2 disk [DISK]               (default: work/qemu/aurora-disk.qcow2)
#   --disk-size SIZE     size of a new disk [DISK_SIZE]  (default: 32G, thin-provisioned qcow2)
#   --no-disk            no virtual disk
#   --boot auto|cd|disk  boot order [BOOT]               (see above)
#   --uefi               UEFI (OVMF) instead of BIOS [UEFI=1]; per-VM writable copy of OVMF_VARS
#                        in work/qemu/<name>.ovmf-vars.fd
#   --secure-boot        UEFI with Secure Boot (Microsoft keys) [SECURE_BOOT=1]. The live ISO's
#                        boot loader is not signed: use this for installed disks only.
#   --ovmf-code FILE     UEFI firmware code [OVMF_CODE]  (default: searched, see below)
#   --ovmf-vars FILE     UEFI variable store template [OVMF_VARS]
#   --mem MB             RAM [MEM]                       (default: 4096)
#   --cpus N             vCPUs [CPUS]                    (default: 4, at most the host's CPUs)
#   --vga virtio|std|virtio-gl  display adapter [VGA]    (default: virtio = virtio-vga;
#                        std = standard VGA (bochs), most compatible; virtio-gl = virgl 3D, needs
#                        a host GPU and the gtk/sdl display with OpenGL)
#   --res WxH            initial screen mode [RES]       (default: 1920x1080 with KVM, 1600x900 TCG)
#   --audio auto|pipewire|pa|sdl|alsa|none  host audio backend [AUDIO] (default: auto =
#                        pipewire, else pulseaudio, else sdl, else none)
#   --display SPEC       QEMU -display value [QEMU_DISPLAY] (default: gtk, else sdl, else VNC on
#                        127.0.0.1:5900 when there is no graphical session)
#   --headless           no window: -display none, QMP + guest-agent sockets, serial log
#   --clipboard          share the clipboard with the guest (qemu-vdagent + spice-vdagent)
#   --name NAME          VM name; state files work/qemu/NAME.* [VM_NAME] (default: aurora)
#   --serial FILE        serial console log (default: work/qemu/NAME.serial.log); the boot menu's
#                        "debug" entry writes kernel/systemd messages there
#   --kernel ARGS        boot casper/vmlinuz+initrd from the ISO directly (no GRUB) with ARGS
#                        appended to "boot=casper console=tty1 console=ttyS0,115200n8"
#   --snapshot           discard all writes to the disk when the VM stops
#   --accel kvm|tcg      accelerator [ACCEL] (default: kvm when /dev/kvm is usable, else TCG)
#   --dry-run, --print   print the commands instead of running them (creates nothing)
#   -- ARGS...           extra QEMU arguments
#
# Firmware search order (--uefi): $OVMF_CODE/$OVMF_VARS, then the usual locations of
# Ubuntu/Debian (ovmf), Fedora/RHEL (edk2-ovmf), Arch (edk2-ovmf), openSUSE (qemu-ovmf-x86_64),
# then QEMU's firmware descriptors (/usr/share/qemu/firmware/*.json).
#
# Automation (headless): tools/qmp.py --sock work/qemu/aurora.qmp screendump shot.png
#                        tools/qmp.py --qga work/qemu/aurora.qga exec -- nmcli -t dev
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

ISO="${ISO:-}"
DISK="${DISK:-}"
DISK_SIZE="${DISK_SIZE:-32G}"
NO_DISK=0
BOOT="${BOOT:-}"
UEFI="${UEFI:-0}"
SECURE_BOOT="${SECURE_BOOT:-0}"
OVMF_CODE="${OVMF_CODE:-}"
OVMF_VARS="${OVMF_VARS:-}"
MEM="${MEM:-4096}"
CPUS="${CPUS:-4}"
VGA="${VGA:-virtio}"
RES="${RES:-}"
AUDIO="${AUDIO:-auto}"
HEADLESS="${HEADLESS:-0}"
DISPLAY_SPEC="${QEMU_DISPLAY:-}"
CLIPBOARD=0
VM_NAME="${VM_NAME:-aurora}"
SERIAL=""
KERNEL_ARGS=""
DIRECT_KERNEL=0
SNAPSHOT=0
ACCEL="${ACCEL:-}"
DRY_RUN="${DRY_RUN:-0}"
EXTRA=()

die()  { echo "qemu-run: error: $*" >&2; exit 1; }
note() { echo "qemu-run: $*" >&2; }
usage() { sed -n '3,/^set -E/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'; }
need_arg() { [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value (see --help)"; }

while (($#)); do
  case "$1" in
    --iso) need_arg "$@"; ISO="$2"; shift 2 ;;
    --disk) need_arg "$@"; DISK="$2"; shift 2 ;;
    --disk-size) need_arg "$@"; DISK_SIZE="$2"; shift 2 ;;
    --no-disk) NO_DISK=1; shift ;;
    --boot) need_arg "$@"; BOOT="$2"; shift 2 ;;
    --uefi) UEFI=1; shift ;;
    --bios) UEFI=0; shift ;;
    --secure-boot) UEFI=1; SECURE_BOOT=1; shift ;;
    --ovmf-code) need_arg "$@"; OVMF_CODE="$2"; shift 2 ;;
    --ovmf-vars) need_arg "$@"; OVMF_VARS="$2"; shift 2 ;;
    --mem) need_arg "$@"; MEM="$2"; shift 2 ;;
    --cpus) need_arg "$@"; CPUS="$2"; shift 2 ;;
    --vga) need_arg "$@"; VGA="$2"; shift 2 ;;
    --res) need_arg "$@"; RES="$2"; shift 2 ;;
    --audio) need_arg "$@"; AUDIO="$2"; shift 2 ;;
    --display) need_arg "$@"; DISPLAY_SPEC="$2"; shift 2 ;;
    --headless) HEADLESS=1; shift ;;
    --clipboard) CLIPBOARD=1; shift ;;
    --name) need_arg "$@"; VM_NAME="$2"; shift 2 ;;
    --serial) need_arg "$@"; SERIAL="$2"; shift 2 ;;
    --kernel) [[ $# -ge 2 ]] || die "--kernel needs a value (may be empty: --kernel '')"
              DIRECT_KERNEL=1; KERNEL_ARGS="$2"; shift 2 ;;
    --snapshot) SNAPSHOT=1; shift ;;
    --accel) need_arg "$@"; ACCEL="$2"; shift 2 ;;
    --dry-run|--print) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; EXTRA+=("$@"); break ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

if ! [[ "$MEM" =~ ^[0-9]+$ ]] || ((MEM < 1024)); then die "--mem must be a number of MB >= 1024 (got '$MEM')"; fi
if ! [[ "$CPUS" =~ ^[0-9]+$ ]] || ((CPUS < 1)); then die "--cpus must be a positive number (got '$CPUS')"; fi
[[ "$UEFI" == 0 || "$UEFI" == 1 ]] || die "UEFI must be 0 or 1"
[[ "$VM_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "bad --name '$VM_NAME' (letters, digits, . _ -)"

QEMU="${QEMU:-qemu-system-x86_64}"
QEMU_IMG="${QEMU_IMG:-qemu-img}"
STATE="$ROOT/work/qemu"

# Shell-quote for display: plain words stay readable (QEMU options are full of commas).
shq() {
  local a out=()
  for a in "$@"; do
    if [[ "$a" =~ ^[A-Za-z0-9_./:=,+@%-]+$ ]]; then out+=("$a"); else out+=("'${a//\'/\'\\\'\'}'"); fi
  done
  echo "${out[*]}"
}
# Commands that change something on the host; in --dry-run they are only printed.
PRE_CMDS=()
run_or_print() { # cmd...
  if ((DRY_RUN)); then
    local c c_new; c_new="$(shq "$@")"
    for c in "${PRE_CMDS[@]}"; do [[ "$c" == "$c_new" ]] && return 0; done
    PRE_CMDS+=("$c_new")
  else
    "$@"
  fi
}

if ! command -v "$QEMU" >/dev/null 2>&1; then
  msg="$QEMU not found. Install QEMU: Ubuntu/Debian: sudo apt install qemu-system-x86 qemu-utils (+ ovmf for UEFI);
  Fedora: sudo dnf install qemu-kvm qemu-img edk2-ovmf;  Arch: sudo pacman -S qemu-desktop edk2-ovmf"
  if ((DRY_RUN)); then note "warning: $msg"; else die "$msg"; fi
fi

# ---- QEMU optional modules (probed from the module directory; QEMU itself is never run) -----
QEMU_MODULE_DIRS=(/usr/lib/x86_64-linux-gnu/qemu /usr/lib64/qemu /usr/lib/qemu /usr/local/lib/x86_64-linux-gnu/qemu
                  /usr/local/lib64/qemu /usr/local/lib/qemu)
have_module() { # name (e.g. ui-gtk, audio-pa) -> true if available or QEMU is not modular
  local d modular=0
  for d in "${QEMU_MODULE_DIRS[@]}"; do
    [[ -d "$d" ]] || continue
    compgen -G "$d/*.so" >/dev/null || continue
    modular=1
    [[ -e "$d/$1.so" ]] && return 0
  done
  ((modular == 0))
}

# ---- media -------------------------------------------------------------------------------
BOOT="${BOOT:-auto}"
case "$BOOT" in auto|cd|disk) ;; *) die "--boot must be auto, cd or disk (got '$BOOT')" ;; esac
if ((DIRECT_KERNEL)) && [[ "$BOOT" == disk ]]; then die "--kernel boots the ISO; it cannot be combined with --boot disk"; fi
if [[ "$BOOT" != disk ]]; then
  if [[ -z "$ISO" ]]; then
    ISO="$(find "$ROOT/out" -maxdepth 1 -name 'aurora-os-*.iso' -printf '%T@ %p\n' 2>/dev/null | sort -rn | sed -n '1s/^[^ ]* //p')"
  fi
  [[ -n "$ISO" && -f "$ISO" ]] || die "no ISO found${ISO:+ at $ISO} (build one with 'make iso' or pass --iso PATH)"
  ISO="$(readlink -f "$ISO")"
else
  ISO=""
fi
((NO_DISK)) && [[ "$BOOT" == disk ]] && die "--no-disk and --boot disk exclude each other"
if ((NO_DISK == 0)); then
  DISK="${DISK:-$STATE/aurora-disk.qcow2}"
  if [[ ! -f "$DISK" ]]; then
    if [[ "$BOOT" == disk ]]; then
      ((DRY_RUN)) || die "disk $DISK does not exist (install Aurora OS first: make run)"
      note "warning: disk $DISK does not exist yet (install Aurora OS first: make run)"
    fi
    if [[ "$BOOT" != disk ]]; then
      command -v "$QEMU_IMG" >/dev/null 2>&1 || ((DRY_RUN)) || die "$QEMU_IMG not found (Ubuntu/Debian: sudo apt install qemu-utils)"
      run_or_print mkdir -p "$(dirname "$DISK")"
      run_or_print "$QEMU_IMG" create -q -f qcow2 "$DISK" "$DISK_SIZE"
      ((DRY_RUN)) || note "created $DISK ($DISK_SIZE, grows on demand)"
    fi
  fi
fi
((DRY_RUN)) || mkdir -p "$STATE"

# ---- accelerator -------------------------------------------------------------------------
if [[ -z "$ACCEL" ]]; then
  if [[ -r /dev/kvm && -w /dev/kvm ]]; then
    ACCEL=kvm
  else
    ACCEL=tcg
    if [[ -e /dev/kvm ]]; then
      note "/dev/kvm exists but $(id -un) cannot use it: sudo usermod -aG kvm $(id -un)  (then log out and back in)"
    else
      note "no /dev/kvm: enable virtualization (VT-x/AMD-V) in the firmware setup and load kvm_intel or kvm_amd"
    fi
    note "falling back to TCG emulation: expect a slow boot (several minutes)"
  fi
fi
MACHINE="q35,vmport=off"
case "$ACCEL" in
  kvm) ACCEL_ARGS=(-accel kvm -cpu host) ;;
  tcg) ACCEL_ARGS=(-accel "tcg,thread=multi,tb-size=1024" -cpu max) ;;
  *) die "unknown --accel $ACCEL (kvm|tcg)" ;;
esac
HOST_CPUS="$(nproc 2>/dev/null || echo 1)"
if ((CPUS > HOST_CPUS)); then note "only $HOST_CPUS host CPUs: using --cpus $HOST_CPUS"; CPUS=$HOST_CPUS; fi
if [[ -z "$RES" ]]; then
  if [[ "$ACCEL" == kvm ]]; then RES=1920x1080; else RES=1600x900; fi
fi
[[ "$RES" =~ ^([0-9]+)x([0-9]+)$ ]] || die "bad --res $RES (expected WxH, e.g. 1920x1080)"
XRES="${BASH_REMATCH[1]}"; YRES="${BASH_REMATCH[2]}"

# ---- firmware ----------------------------------------------------------------------------
FW_ARGS=()
fw_format() { case "$1" in *.qcow2) echo qcow2 ;; *) echo raw ;; esac; }
find_ovmf_pair() { # secure(0|1) -> "CODE VARS" from well-known locations
  local pairs p code vars
  if [[ "$1" == 1 ]]; then
    pairs=(
      "/usr/share/OVMF/OVMF_CODE_4M.ms.fd /usr/share/OVMF/OVMF_VARS_4M.ms.fd"                    # Ubuntu
      "/usr/share/OVMF/OVMF_CODE_4M.secboot.fd /usr/share/OVMF/OVMF_VARS_4M.ms.fd"               # Debian
      "/usr/share/edk2/ovmf/OVMF_CODE.secboot.fd /usr/share/edk2/ovmf/OVMF_VARS.secboot.fd"      # Fedora/RHEL
      "/usr/share/qemu/ovmf-x86_64-smm-ms-code.bin /usr/share/qemu/ovmf-x86_64-smm-ms-vars.bin"  # openSUSE
    )
  else
    pairs=(
      "/usr/share/OVMF/OVMF_CODE_4M.fd /usr/share/OVMF/OVMF_VARS_4M.fd"                          # Ubuntu 22.04+, Debian 12+
      "/usr/share/OVMF/OVMF_CODE.fd /usr/share/OVMF/OVMF_VARS.fd"                                # older Ubuntu/Debian
      "/usr/share/edk2/ovmf/OVMF_CODE.fd /usr/share/edk2/ovmf/OVMF_VARS.fd"                      # Fedora/RHEL
      "/usr/share/edk2/x64/OVMF_CODE.4m.fd /usr/share/edk2/x64/OVMF_VARS.4m.fd"                  # Arch
      "/usr/share/edk2-ovmf/x64/OVMF_CODE.fd /usr/share/edk2-ovmf/x64/OVMF_VARS.fd"              # older Arch
      "/usr/share/edk2/OvmfX64/OVMF_CODE.fd /usr/share/edk2/OvmfX64/OVMF_VARS.fd"                # Gentoo
      "/usr/share/qemu/ovmf-x86_64-4m-code.bin /usr/share/qemu/ovmf-x86_64-4m-vars.bin"          # openSUSE
      "/usr/share/qemu/ovmf-x86_64-code.bin /usr/share/qemu/ovmf-x86_64-vars.bin"                # older openSUSE
    )
  fi
  for p in "${pairs[@]}"; do
    code="${p% *}"; vars="${p#* }"
    if [[ -f "$code" && -f "$vars" ]]; then echo "$code $vars"; return 0; fi
  done
  # QEMU firmware descriptors (docs/interop/firmware.json), lowest file name first.
  command -v python3 >/dev/null 2>&1 || return 1
  python3 -I - "$1" <<'PY'
import glob, json, os, sys
secure = sys.argv[1] == "1"
files = {}
for d in ("/usr/share/qemu/firmware", "/etc/qemu/firmware"):
    for f in glob.glob(os.path.join(d, "*.json")):
        files[os.path.basename(f)] = f          # /etc overrides /usr/share
for name in sorted(files):
    try:
        fw = json.load(open(files[name]))
    except Exception:
        continue
    if "uefi" not in fw.get("interface-types", []):
        continue
    if not any(t.get("architecture") == "x86_64" and any("q35" in m for m in t.get("machines", []))
               for t in fw.get("targets", [])):
        continue
    feats = set(fw.get("features", []))
    # "amd-sev" only means SEV-capable (Ubuntu/Fedora list it on their normal OVMF builds);
    # skip the confidential-computing-only builds (stateless, no variable store).
    if feats & {"amd-sev-es", "amd-sev-snp", "intel-tdx"}:
        continue
    if secure != ("secure-boot" in feats and "enrolled-keys" in feats):
        continue
    if not secure and "secure-boot" in feats:
        continue
    m = fw.get("mapping", {})
    if m.get("device") != "flash" or m.get("mode", "split") != "split":
        continue
    code = m.get("executable", {}).get("filename")
    vars_ = m.get("nvram-template", {}).get("filename")
    if code and vars_ and os.path.isfile(code) and os.path.isfile(vars_):
        print(code, vars_)
        sys.exit(0)
sys.exit(1)
PY
}
if [[ "$UEFI" == 1 ]]; then
  if [[ -z "$OVMF_CODE" || -z "$OVMF_VARS" ]]; then
    pair="$(find_ovmf_pair "$SECURE_BOOT")" || {
      if ((SECURE_BOOT)); then die "no Secure Boot OVMF firmware with Microsoft keys found (set OVMF_CODE/OVMF_VARS)"; fi
      die "OVMF (UEFI firmware for QEMU) not found. Ubuntu/Debian: sudo apt install ovmf;  Fedora: sudo dnf install edk2-ovmf;
  Arch: sudo pacman -S edk2-ovmf;  openSUSE: sudo zypper install qemu-ovmf-x86_64  (or set OVMF_CODE and OVMF_VARS)"
    }
    OVMF_CODE="${OVMF_CODE:-${pair% *}}"; OVMF_VARS="${OVMF_VARS:-${pair#* }}"
  fi
  [[ -f "$OVMF_CODE" ]] || die "OVMF code $OVMF_CODE not found"
  [[ -f "$OVMF_VARS" ]] || die "OVMF vars template $OVMF_VARS not found"
  # The variable store is written by the firmware (boot entries): every VM gets its own copy.
  vars_ext="fd"; [[ "$(fw_format "$OVMF_VARS")" == qcow2 ]] && vars_ext="qcow2"
  sb_suffix=""; ((SECURE_BOOT)) && sb_suffix="-sb"
  VARS="$STATE/$VM_NAME.ovmf-vars$sb_suffix.$vars_ext"
  if [[ ! -f "$VARS" ]]; then
    run_or_print mkdir -p "$STATE"
    run_or_print cp "$OVMF_VARS" "$VARS"
    run_or_print chmod u+w "$VARS"
  fi
  if ((SECURE_BOOT)); then
    MACHINE+=",smm=on"
    FW_ARGS+=(-global "driver=cfi.pflash01,property=secure,value=on")
    note "Secure Boot: the live ISO's boot loader is not signed — use this for installed disks"
  fi
  FW_ARGS+=(-drive "if=pflash,format=$(fw_format "$OVMF_CODE"),unit=0,readonly=on,file=$OVMF_CODE"
            -drive "if=pflash,format=$(fw_format "$OVMF_VARS"),unit=1,file=$VARS")
fi

# ---- assemble the command line -----------------------------------------------------------
args=(-name "$VM_NAME" -machine "$MACHINE" "${ACCEL_ARGS[@]}" -m "$MEM" -smp "$CPUS" -rtc base=utc)
args+=("${FW_ARGS[@]}")

# Disks: virtio disk + SATA CD-ROM (q35 AHCI). bootindex sets the firmware boot order.
# Indexes start at 1: with -kernel (--kernel) QEMU gives bootindex 0 to its linuxboot option ROM,
# and a device asking for 0 as well makes QEMU exit ("The bootindex 0 has already been used").
DISK_IDX=1; CD_IDX=2
[[ "$BOOT" == cd ]] && { CD_IDX=1; DISK_IDX=2; }
if ((NO_DISK == 0)); then
  snap=""; ((SNAPSHOT)) && snap=",snapshot=on"
  args+=(-drive "file=$DISK,if=none,id=hd0,format=qcow2,discard=unmap,detect-zeroes=unmap,cache=writeback$snap"
         -device "virtio-blk-pci,drive=hd0,bootindex=$DISK_IDX")
fi
if [[ -n "$ISO" ]]; then
  cd_boot=",bootindex=$CD_IDX"
  ((DIRECT_KERNEL)) && cd_boot=""   # -kernel boots first; the CD only provides the squashfs
  args+=(-drive "file=$ISO,if=none,id=cd0,media=cdrom,format=raw,readonly=on"
         -device "ide-cd,drive=cd0,bus=ide.1$cd_boot")
fi
if ((DIRECT_KERNEL)); then
  command -v xorriso >/dev/null 2>&1 || ((DRY_RUN)) || die "--kernel needs xorriso to extract the kernel from the ISO"
  KDIR="$STATE/kernel-$(stat -c %Y "$ISO")"
  if [[ ! -s "$KDIR/vmlinuz" || ! -s "$KDIR/initrd" ]]; then
    ((DRY_RUN)) || rm -rf "$STATE"/kernel-*
    run_or_print mkdir -p "$KDIR"
    run_or_print xorriso -osirrox on -indev "$ISO" -extract /casper/vmlinuz "$KDIR/vmlinuz" \
      -extract /casper/initrd "$KDIR/initrd"
  fi
  args+=(-kernel "$KDIR/vmlinuz" -initrd "$KDIR/initrd"
         -append "boot=casper console=tty1 console=ttyS0,115200n8${KERNEL_ARGS:+ $KERNEL_ARGS} ---")
fi

# Display adapter.
args+=(-vga none)
case "$VGA" in
  virtio) args+=(-device "virtio-vga,xres=$XRES,yres=$YRES") ;;
  std) args+=(-device "VGA,edid=on,xres=$XRES,yres=$YRES") ;;
  virtio-gl) args+=(-device "virtio-vga-gl,xres=$XRES,yres=$YRES") ;;
  *) die "unknown --vga $VGA (virtio|std|virtio-gl)" ;;
esac

# Display backend.
GUI=0
if ((HEADLESS)); then
  DISPLAY_SPEC=none
elif [[ -z "$DISPLAY_SPEC" ]]; then
  if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
    if have_module ui-gtk; then DISPLAY_SPEC="gtk,zoom-to-fit=on"
    elif have_module ui-sdl; then DISPLAY_SPEC="sdl"
    else
      DISPLAY_SPEC="vnc=127.0.0.1:0"
      note "QEMU has no gtk/sdl display here (Ubuntu/Debian: sudo apt install qemu-system-gui); using VNC 127.0.0.1:5900"
    fi
  else
    DISPLAY_SPEC="vnc=127.0.0.1:0"
    note "no graphical session: the VM screen is on VNC 127.0.0.1:5900 (e.g. vncviewer 127.0.0.1:0)"
  fi
fi
[[ "$VGA" == virtio-gl && "$DISPLAY_SPEC" =~ ^(gtk|sdl)($|,) && "$DISPLAY_SPEC" != *gl=* ]] && DISPLAY_SPEC+=",gl=on"
[[ "$DISPLAY_SPEC" =~ ^(gtk|sdl) ]] && GUI=1
args+=(-display "$DISPLAY_SPEC")

# Input, network, entropy.
args+=(-device qemu-xhci,id=xhci -device usb-tablet,bus=xhci.0)
args+=(-nic user,model=virtio-net-pci)
args+=(-device virtio-rng-pci)

# Audio: Intel HDA codec in the guest, host backend picked automatically.
RUNDIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [[ "$AUDIO" == auto ]]; then
  if ((HEADLESS)); then AUDIO=none
  elif [[ -S "$RUNDIR/pipewire-0" ]] && have_module audio-pipewire; then AUDIO=pipewire
  elif [[ -S "$RUNDIR/pulse/native" ]] && have_module audio-pa; then AUDIO=pa
  elif ((GUI)) && have_module audio-sdl; then AUDIO=sdl
  else AUDIO=none; fi
fi
case "$AUDIO" in
  pipewire|pa|sdl|alsa|none) args+=(-audiodev "$AUDIO,id=snd0") ;;
  pulseaudio) AUDIO=pa; args+=(-audiodev "pa,id=snd0") ;;
  *) die "unknown --audio $AUDIO (auto|pipewire|pa|sdl|alsa|none)" ;;
esac
args+=(-device intel-hda -device hda-duplex,audiodev=snd0)

# Guest agent channel (qemu-guest-agent runs in Aurora OS) and optional clipboard sharing.
QGA_SOCK="$STATE/$VM_NAME.qga"
QMP_SOCK="$STATE/$VM_NAME.qmp"
args+=(-device virtio-serial-pci
       -chardev "socket,path=$QGA_SOCK,server=on,wait=off,id=qga0"
       -device "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0")
if ((CLIPBOARD)); then
  args+=(-chardev "qemu-vdagent,id=vdagent0,name=vdagent,clipboard=on,mouse=off"
         -device "virtserialport,chardev=vdagent0,name=com.redhat.spice.0")
fi

# Machine monitor (QMP) for tools/qmp.py, serial console to a file.
SERIAL="${SERIAL:-$STATE/$VM_NAME.serial.log}"
args+=(-qmp "unix:$QMP_SOCK,server=on,wait=off" -serial "file:$SERIAL")
((HEADLESS)) && args+=(-monitor none)

args+=("${EXTRA[@]}")

firmware=BIOS
if [[ "$UEFI" == 1 ]]; then firmware=UEFI; ((SECURE_BOOT)) && firmware="UEFI + Secure Boot"; fi
summary="$firmware, $ACCEL, ${MEM} MB, $CPUS vCPU, $VGA ${RES}, audio=$AUDIO, display=$DISPLAY_SPEC, boot=$BOOT"
[[ -n "$ISO" ]] && summary+=", iso=${ISO##*/}"
if ((DRY_RUN)); then
  note "dry run ($summary) — nothing is started or created"
  for c in "${PRE_CMDS[@]}"; do echo "$c"; done
  shq "$QEMU" "${args[@]}"
  exit 0
fi
rm -f "$QMP_SOCK" "$QGA_SOCK"
note "$summary"
note "QMP $QMP_SOCK  guest agent $QGA_SOCK  serial log $SERIAL"
exec "$QEMU" "${args[@]}"
