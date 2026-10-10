#!/usr/bin/env bash
# Aurora OS — QEMU launcher for testing the ISO and installed disks.
#
#   tools/qemu-run.sh                         boot the newest out/*.iso (BIOS) with a 32G disk
#   tools/qemu-run.sh --uefi                  same with UEFI firmware (OVMF)
#   tools/qemu-run.sh --boot disk             boot the installed disk only (no ISO)
#   tools/qemu-run.sh --headless              no window; QMP + guest agent sockets for automation
#   tools/qemu-run.sh --kernel "aurora.debug" boot casper/vmlinuz+initrd from the ISO directly
#                                             with extra kernel arguments (serial console on)
#
# Options (environment variables in brackets):
#   --iso PATH        ISO to boot [ISO]            (default: newest out/aurora-os-*.iso)
#   --disk PATH       qcow2 disk [DISK]            (default: work/qemu/aurora-disk.qcow2, created if missing)
#   --disk-size SIZE  size for a new disk [DISK_SIZE] (default 32G)
#   --no-disk         no hard disk
#   --boot cd|disk    boot device (default: cd when an ISO is used)
#   --uefi            UEFI (OVMF) instead of BIOS; NVRAM kept next to the disk [UEFI=1]
#   --secure-boot     UEFI with Secure Boot enforced (Microsoft keys)
#   --mem MB          RAM [MEM] (default 4096)
#   --cpus N          vCPUs [CPUS] (default 4)
#   --vga virtio|std  display adapter [VGA] (default virtio; std = bochs VGA)
#   --res WxH         preferred screen mode [RES] (default 1920x1080 with KVM, 1600x900 under TCG)
#   --audio pa|sdl|none|auto  host audio backend [AUDIO] (default auto)
#   --headless        -display none, QMP socket, guest-agent socket, serial log to a file
#   --display SPEC    QEMU -display value (default gtk, or sdl, or vnc=:0 without $DISPLAY)
#   --name NAME       instance name; sockets/logs go to work/qemu/NAME.* [NAME] (default aurora)
#   --serial FILE     write the serial console to FILE (default work/qemu/NAME.serial.log)
#   --kernel ARGS     direct kernel boot from the ISO with ARGS appended (implies --boot cd)
#   --snapshot        do not write to the disk (changes are discarded)
#   --accel kvm|tcg   force the accelerator [ACCEL] (default: kvm when /dev/kvm is usable)
#   --dry-run         print the QEMU command line and exit
#   -- ARGS...        extra QEMU arguments
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
SECURE_BOOT=0
MEM="${MEM:-4096}"
CPUS="${CPUS:-4}"
VGA="${VGA:-virtio}"
RES="${RES:-}"
AUDIO="${AUDIO:-auto}"
HEADLESS="${HEADLESS:-0}"
DISPLAY_SPEC="${QEMU_DISPLAY:-}"
NAME="${NAME:-aurora}"
SERIAL=""
KERNEL_ARGS=""
DIRECT_KERNEL=0
SNAPSHOT=0
ACCEL="${ACCEL:-}"
DRY_RUN=0
EXTRA=()

die() { echo "qemu-run: $*" >&2; exit 1; }
usage() { sed -n '2,/^set -E/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --iso) ISO="$2"; shift 2 ;;
    --disk) DISK="$2"; shift 2 ;;
    --disk-size) DISK_SIZE="$2"; shift 2 ;;
    --no-disk) NO_DISK=1; shift ;;
    --boot) BOOT="$2"; shift 2 ;;
    --uefi) UEFI=1; shift ;;
    --secure-boot) UEFI=1; SECURE_BOOT=1; shift ;;
    --mem) MEM="$2"; shift 2 ;;
    --cpus) CPUS="$2"; shift 2 ;;
    --vga) VGA="$2"; shift 2 ;;
    --res) RES="$2"; shift 2 ;;
    --audio) AUDIO="$2"; shift 2 ;;
    --headless) HEADLESS=1; shift ;;
    --display) DISPLAY_SPEC="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --serial) SERIAL="$2"; shift 2 ;;
    --kernel) DIRECT_KERNEL=1; KERNEL_ARGS="$2"; shift 2 ;;
    --snapshot) SNAPSHOT=1; shift ;;
    --accel) ACCEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; EXTRA+=("$@"); break ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

QEMU="${QEMU:-qemu-system-x86_64}"
command -v "$QEMU" >/dev/null || die "$QEMU not found (apt-get install qemu-system-x86)"
STATE="$ROOT/work/qemu"
mkdir -p "$STATE"

# ---- media -------------------------------------------------------------------------------
if [[ "$BOOT" != disk ]]; then
  if [[ -z "$ISO" ]]; then
    ISO="$(ls -1t "$ROOT"/out/aurora-os-*.iso 2>/dev/null | head -n1 || true)"
  fi
  [[ -n "$ISO" && -f "$ISO" ]] || die "no ISO found (build one with 'make iso' or pass --iso)"
  BOOT="${BOOT:-cd}"
fi
if ((NO_DISK)) && [[ "$BOOT" == disk ]]; then die "--no-disk and --boot disk are exclusive"; fi
if ((NO_DISK == 0)); then
  DISK="${DISK:-$STATE/aurora-disk.qcow2}"
  if [[ ! -f "$DISK" ]] && ((DRY_RUN == 0)); then
    [[ "$BOOT" == disk ]] && die "disk $DISK does not exist (install Aurora OS first: make run)"
    command -v qemu-img >/dev/null || die "qemu-img not found (apt-get install qemu-utils)"
    qemu-img create -q -f qcow2 "$DISK" "$DISK_SIZE"
    echo "qemu-run: created $DISK ($DISK_SIZE)" >&2
  fi
fi

# ---- accelerator -------------------------------------------------------------------------
if [[ -z "$ACCEL" ]]; then
  if [[ -r /dev/kvm && -w /dev/kvm ]]; then ACCEL=kvm; else ACCEL=tcg; fi
fi
args=(-name "$NAME" -machine q35,vmport=off -m "$MEM" -smp "$CPUS" -rtc base=utc)
case "$ACCEL" in
  kvm) args+=(-accel kvm -cpu host) ;;
  tcg) args+=(-accel tcg,thread=multi,tb-size=1024 -cpu max)
       echo "qemu-run: KVM not available — using TCG emulation (slow)" >&2 ;;
  *) die "unknown accelerator $ACCEL" ;;
esac
if [[ -z "$RES" ]]; then
  if [[ "$ACCEL" == kvm ]]; then RES=1920x1080; else RES=1600x900; fi
fi
[[ "$RES" =~ ^([0-9]+)x([0-9]+)$ ]] || die "bad --res $RES (expected WxH)"
XRES="${BASH_REMATCH[1]}"; YRES="${BASH_REMATCH[2]}"

# ---- firmware ----------------------------------------------------------------------------
if [[ "$UEFI" == 1 ]]; then
  find_fw() { local f; for f in "$@"; do [[ -f "$f" ]] && { echo "$f"; return 0; }; done; return 1; }
  if ((SECURE_BOOT)); then
    CODE="$(find_fw /usr/share/OVMF/OVMF_CODE_4M.secboot.fd /usr/share/OVMF/OVMF_CODE_4M.ms.fd)" || die "OVMF secure boot firmware not found (apt-get install ovmf)"
    VARS_TEMPLATE="$(find_fw /usr/share/OVMF/OVMF_VARS_4M.ms.fd)" || die "OVMF_VARS_4M.ms.fd not found"
    args+=(-global driver=cfi.pflash01,property=secure,value=on -machine smm=on)
    VARS="$STATE/$NAME.ovmf-vars-sb.fd"
  else
    CODE="$(find_fw /usr/share/OVMF/OVMF_CODE_4M.fd /usr/share/OVMF/OVMF_CODE.fd /usr/share/qemu/OVMF.fd)" || die "OVMF not found (apt-get install ovmf)"
    VARS_TEMPLATE="$(find_fw /usr/share/OVMF/OVMF_VARS_4M.fd /usr/share/OVMF/OVMF_VARS.fd)" || die "OVMF_VARS not found"
    VARS="$STATE/$NAME.ovmf-vars.fd"
  fi
  [[ -f "$VARS" ]] || cp "$VARS_TEMPLATE" "$VARS"
  args+=(-drive "if=pflash,format=raw,unit=0,readonly=on,file=$CODE"
         -drive "if=pflash,format=raw,unit=1,file=$VARS")
fi

# ---- disks -------------------------------------------------------------------------------
if ((NO_DISK == 0)); then
  local_snap=""
  ((SNAPSHOT)) && local_snap=",snapshot=on"
  args+=(-drive "file=$DISK,if=none,id=hd0,format=qcow2,discard=unmap,cache=writeback$local_snap"
         -device "virtio-blk-pci,drive=hd0,bootindex=$([[ "$BOOT" == disk ]] && echo 0 || echo 1)")
fi
if [[ -n "$ISO" && "$BOOT" != disk ]]; then
  cd_boot=",bootindex=0"
  ((DIRECT_KERNEL)) && cd_boot=""   # -kernel takes the first boot slot
  args+=(-drive "file=$ISO,if=none,id=cd0,media=cdrom,readonly=on"
         -device "ide-cd,drive=cd0,bus=ide.1$cd_boot")
fi
if ((DIRECT_KERNEL)); then
  command -v xorriso >/dev/null || die "--kernel needs xorriso to extract the kernel from the ISO"
  KDIR="$STATE/kernel-$(stat -c %Y "$ISO")"
  if [[ ! -s "$KDIR/vmlinuz" || ! -s "$KDIR/initrd" ]]; then
    rm -rf "$STATE"/kernel-*; mkdir -p "$KDIR"
    xorriso -osirrox on -indev "$ISO" -extract /casper/vmlinuz "$KDIR/vmlinuz" \
      -extract /casper/initrd "$KDIR/initrd" >/dev/null 2>&1 || die "cannot extract the kernel from $ISO"
  fi
  args+=(-kernel "$KDIR/vmlinuz" -initrd "$KDIR/initrd"
         -append "boot=casper console=tty1 console=ttyS0,115200n8 $KERNEL_ARGS ---")
fi

# ---- display, input, network, audio ------------------------------------------------------
args+=(-vga none)
case "$VGA" in
  virtio) args+=(-device "virtio-vga,xres=$XRES,yres=$YRES") ;;
  std) args+=(-device "VGA,edid=on,xres=$XRES,yres=$YRES") ;;
  virtio-gl) args+=(-device "virtio-vga-gl,xres=$XRES,yres=$YRES"); DISPLAY_SPEC="${DISPLAY_SPEC:-gtk,gl=on}" ;;
  *) die "unknown --vga $VGA (virtio|std|virtio-gl)" ;;
esac
args+=(-device qemu-xhci,id=xhci -device usb-tablet,bus=xhci.0)
args+=(-nic user,model=virtio-net-pci)
args+=(-device virtio-rng-pci)

if [[ "$AUDIO" == auto ]]; then
  if ((HEADLESS)); then AUDIO=none
  elif [[ -S "${XDG_RUNTIME_DIR:-/nonexistent}/pulse/native" ]]; then AUDIO=pa
  elif [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then AUDIO=sdl
  else AUDIO=none; fi
fi
case "$AUDIO" in
  pa|sdl|none|alsa|pipewire) args+=(-audiodev "$AUDIO,id=snd0") ;;
  *) die "unknown --audio $AUDIO" ;;
esac
args+=(-device intel-hda -device hda-duplex,audiodev=snd0)

# Guest agent channel (qemu-guest-agent runs in Aurora OS) and SPICE agent port.
QGA_SOCK="$STATE/$NAME.qga"
QMP_SOCK="$STATE/$NAME.qmp"
args+=(-device virtio-serial-pci
       -chardev "socket,path=$QGA_SOCK,server=on,wait=off,id=qga0"
       -device "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0")

SERIAL="${SERIAL:-$STATE/$NAME.serial.log}"
if ((HEADLESS)); then
  args+=(-display none -qmp "unix:$QMP_SOCK,server=on,wait=off" -serial "file:$SERIAL" -monitor none)
else
  if [[ -z "$DISPLAY_SPEC" ]]; then
    if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then DISPLAY_SPEC="gtk,zoom-to-fit=on"
    else DISPLAY_SPEC="vnc=127.0.0.1:0"; echo "qemu-run: no graphical display, VNC on 127.0.0.1:5900" >&2; fi
  fi
  args+=(-display "$DISPLAY_SPEC" -qmp "unix:$QMP_SOCK,server=on,wait=off")
  ((DIRECT_KERNEL)) && args+=(-serial "file:$SERIAL")
fi

args+=("${EXTRA[@]}")

if ((DRY_RUN)); then
  printf '%q ' "$QEMU" "${args[@]}"; echo
  exit 0
fi
rm -f "$QMP_SOCK" "$QGA_SOCK"
echo "qemu-run: $([[ "$UEFI" == 1 ]] && echo UEFI || echo BIOS), $ACCEL, ${MEM} MB, $CPUS vCPU, $VGA ${RES}, boot=$BOOT${ISO:+, iso=$(basename "$ISO")}" >&2
echo "qemu-run: QMP $QMP_SOCK  guest agent $QGA_SOCK${HEADLESS:+  serial $SERIAL}" >&2
exec "$QEMU" "${args[@]}"
