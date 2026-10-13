#!/bin/bash
# tools/test-alongside.sh — « Installer à côté » (dual boot) tests of the root helpers on LOOP DEVICES ONLY:
#   rootfs/usr/lib/aurora/helpers/aurora-disk-probe (aurora-install --probe) and aurora-install --alongside.
#
# Usage (root, on the build machine — never in the live session):
#   sudo tools/test-alongside.sh WORKDIR [--full SQUASHFS]
#
# Every disk it touches is a sparse image file created in WORKDIR, attached with `losetup -f --show -P`; the
# device path is checked against its backing file before every command that writes (no other device is ever
# named). The loop devices are detached at the end, whatever happens.
#   win.img  (64 GiB): ESP 100 MiB (EFI/Microsoft/Boot/bootmgfw.efi, BCD, EFI/Boot/bootx64.efi), MSR 16 MiB,
#            NTFS "Windows" (Windows/System32, Users/… files), NTFS recovery 600 MiB at the end; no free space.
#   arch.img (80 GiB): ESP 512 MiB (EFI/arch/grubx64.efi, EFI/BOOT/BOOTX64.EFI, loader/entries/arch.conf), ext4
#            "arch" 50 GiB (/usr/lib/os-release Arch Linux, home files), ~29.5 GiB unallocated at the end.
# Checks: the probe (systems, ESP, free space, shrink bounds, hibernation / Fast Startup, BIOS refusal, UI shape),
# refusals that write nothing (changed table, size out of bounds, MSR, BIOS mode, hibernated Windows), then the real
# partitioning of --alongside (NTFS shrink, ext4 shrink, free space) stopped after the format stage (--fail-at copy):
# sizes, 1 MiB alignment, the other partitions' entries unchanged, the shrunk file systems' files (sha256), the
# untouched partitions byte for byte (ESP, MSR, recovery), the new ext4 "AURORA".
# Without loop devices: the initramfs check (python3 scan of the cpio headers that replaced lsinitramfs) on synthetic
# images (early + zstd / gzip main archive, with / without scripts/casper, truncated, garbage), and the GRUB wrapper
# /usr/local/sbin/grub-install (adds --no-extra-removable for x86_64-efi; only written by an install « à côté »).
# --full SQUASHFS: also runs complete installations next to "Windows" (copy, configure, boot loader on the shared ESP):
# first one whose boot loader stage « replaces » EFI/BOOT/BOOTX64.EFI and adds EFI/BOOT/fbx64.efi
# (AURORA_INSTALL_TEST_TAMPER_ESP=1): it must fail and leave the ESP exactly as before (Windows files byte for byte,
# no EFI/ubuntu); then a normal one: only EFI/ubuntu added, every other ESP file unchanged; GRUB_DISABLE_OS_PROBER=false;
# the grub-install wrapper and the debconf keys in the target; NVRAM entry skipped.
# cachy.img (40 GiB): the user's PC at a smaller scale — GPT, 1 GiB FAT32 ESP holding Limine (EFI/limine/BOOTX64.EFI,
#            EFI/BOOT/BOOTX64.EFI, limine.conf, vmlinuz-linux-cachyos + initramfs: the kernels live on the ESP), ext4 root
#            (/etc/os-release CachyOS, /etc/fstab mounting the ESP on /boot), no free space. Probe (CachyOS, the chain
#            owner of the ESP), then an install --alongside --shrink 2 that stops (at copy; with --full: at the boot loader,
#            after copy + configure), then the retry: the probe offers the left « Selene OS » partition (plan reuse),
#            --reuse-partition 3 (stops at copy; with --full: complete, with an injected `efibootmgr -v` — Limine first in
#            BootOrder — through AURORA_INSTALL_TEST_EFIBOOTMGR_V): ESP byte-identical except EFI/ubuntu, CachyOS's files
#            intact, one « CachyOS » entry chainloading /EFI/limine/BOOTX64.EFI on the ESP's UUID, the CachyOS partition in
#            GRUB_OS_PROBER_SKIP_LIST (checked against GRUB's own 30_os-prober with a fake os-prober), and a finished
#            installation is never offered for reuse.
set -Eeuo pipefail
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HELPER=$HERE/rootfs/usr/lib/aurora/helpers/aurora-install
PROBE=$HERE/rootfs/usr/lib/aurora/helpers/aurora-disk-probe
W=${1:?usage: tools/test-alongside.sh WORKDIR [--full SQUASHFS]}
FULL=""
[[ "${2:-}" == --full ]] && FULL=${3:?--full needs a squashfs image}
if [[ -n "$FULL" ]]; then FULL=$(readlink -f "$FULL"); [[ -f "$FULL" ]] || { echo "test-alongside: $3 not found" >&2; exit 1; }; fi   # aurora-install takes absolute paths only
[[ $EUID -eq 0 ]] || { echo "test-alongside: run as root (loop devices)" >&2; exit 1; }
for t in losetup sfdisk partx mkfs.vfat mkfs.ext4 mkntfs ntfscp ntfscat ntfsresize ntfs-3g mmd mcopy mtype mdir debugfs python3 sha256sum blkdiscard; do
  command -v "$t" >/dev/null || { echo "test-alongside: $t is required (util-linux fdisk dosfstools e2fsprogs ntfs-3g mtools python3)" >&2; exit 1; }
done
mkdir -p "$W"; W=$(cd "$W" && pwd)
export MTOOLS_SKIP_CHECK=1 AURORA_INSTALL_TEST_NO_FIRMWARE=1

PASS=0 FAILS=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
fail() { FAILS=$((FAILS + 1)); printf 'FAIL  %s\n' "$*"; }
check() { local d=$1; shift; if "$@"; then pass "$d"; else fail "$d"; fi; }

LOOPS=() MNTS=()
cleanup() {
  set +e
  local m d
  for m in "${MNTS[@]}"; do mountpoint -q "$m" && { umount "$m" 2>/dev/null || umount -l "$m"; }; done
  for d in "${LOOPS[@]}"; do losetup -d "$d" 2>/dev/null; done
  echo "detached: ${LOOPS[*]:-none}"
}
trap cleanup EXIT

ATTACHED=""
attach() { # attach IMG: ATTACHED = its loop device (partition nodes created); not in a subshell (LOOPS is global)
  local img dev name
  img=$(readlink -f "$1")
  [[ "$img" == "$W"/* ]] || { echo "refusing $img: not in $W" >&2; exit 1; }
  dev=$(losetup -f --show -P "$img")
  LOOPS+=("$dev")
  name=${dev#/dev/}
  [[ "$(cat "/sys/class/block/$name/loop/backing_file")" == "$img" ]] || { echo "loop device $dev is not $img" >&2; exit 1; }
  partx -u "$dev" >/dev/null 2>&1 || partx -a "$dev" >/dev/null 2>&1 || true
  ATTACHED=$dev
}
ours() { # ours DEV: DEV (or its partition) is one of the loop devices of this test, backed by an image in $W
  local d=$1 base l
  for l in "${LOOPS[@]}"; do
    [[ "$d" == "$l" || "$d" =~ ^${l}p[0-9]+$ ]] || continue
    base=${l#/dev/}
    [[ "$(cat "/sys/class/block/$base/loop/backing_file")" == "$W"/* ]] && return 0
  done
  echo "REFUSED: $d is not a loop device created by this test" >&2; exit 1
}
fp() { sfdisk --dump "$1" | sha256sum | cut -d' ' -f1; }
rawsum() { ours "$1"; sha256sum <"$1" | cut -d' ' -f1; }
rand() { head -c "$2" /dev/urandom >"$1"; }
FAKE_SRC=$W/fake-source   # passes resolve_source; the runs stop before the copy (--fail-at copy)
mkdir -p "$FAKE_SRC/usr/lib" "$FAKE_SRC/etc"
printf 'NAME="Selene OS"\nID=ubuntu\nIMAGE_ID=aurora-os\n' >"$FAKE_SRC/usr/lib/os-release"
printf 'root:x:0:0:root:/root:/bin/bash\n' >"$FAKE_SRC/etc/passwd"
install_args() { # install_args DISK -> common aurora-install arguments
  printf '%s\n' --json --password-stdin --disk "$1" --user anna --fullname Anna --lang fr --keyboard fr --timezone UTC \
    --source "$FAKE_SRC" --medium "$W" --log "$W/install.log"
}
run_install() { # run_install OUTFILE DISK ARGS... -> exit code (JSON lines in OUTFILE)
  local out=$1 disk=$2 rc=0; shift 2
  ours "$disk"
  mapfile -t base < <(install_args "$disk")
  echo 'pw-test-123' | "$HELPER" "${base[@]}" "$@" >"$out" 2>>"$W/install.stderr" || rc=$?
  return "$rc"
}
jget() { python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {"d": d}))' "$@"; }

# ====================================================================== initramfs check (no loop device)
echo "== initramfs check: python3 scan of the cpio headers (replaces lsinitramfs)"
eval "$(sed -n "/^INITRAMFS_SCAN_PY='/,/^'\$/p" "$HELPER")"
[[ -n "${INITRAMFS_SCAN_PY:-}" ]] || fail "INITRAMFS_SCAN_PY not found in the helper"
python3 -I - "$W" <<'MKINITRD'
import os, subprocess, sys
w = sys.argv[1]
def cpio(entries):
    out, ino = b"", 1
    for name, data in entries + [("TRAILER!!!", b"")]:
        n = name.encode() + b"\0"
        mode = 0o100644 if data is not None else 0o040755
        data = data or b""
        h = b"070701" + b"".join(b"%08X" % v for v in (ino, mode, 0, 0, 1, 0, len(data), 0, 0, 0, 0, len(n), 0))
        out += h + n; out += b"\0" * (-len(out) % 4); out += data; out += b"\0" * (-len(out) % 4); ino += 1
    return out + b"\0" * (-len(out) % 512)
early = cpio([("kernel", None), ("kernel/x86/microcode/GenuineIntel.bin", os.urandom(3 << 20))])
main_ok = [("scripts", None), ("scripts/init-top/udev", b"#!/bin/sh\n"), ("init", b"#!/bin/sh\n" * 1000)]
main_casper = main_ok + [("scripts/casper", b"#!/bin/sh\n"), ("scripts/casper-bottom/25adduser", b"x")]
def zst(b): return subprocess.run(["zstd", "-q", "-c", "-19"], input=b, stdout=subprocess.PIPE, check=True).stdout
open(f"{w}/initrd-clean.img", "wb").write(early + early + zst(cpio(main_ok)))
open(f"{w}/initrd-casper.img", "wb").write(early + zst(cpio(main_casper)))
open(f"{w}/initrd-gzip-casper.img", "wb").write(early + subprocess.run(["gzip", "-c"], input=cpio(main_casper), stdout=subprocess.PIPE, check=True).stdout)
z = zst(cpio(main_casper)); open(f"{w}/initrd-truncated.img", "wb").write(early + z[: len(z) // 2])
open(f"{w}/initrd-garbage.img", "wb").write(early + b"\x42" * 4096)
open(f"{w}/initrd-cut-early.img", "wb").write(early[: len(early) // 2])
MKINITRD
scan() { local rc=0; python3 -I -c "$INITRAMFS_SCAN_PY" "$W/$1" >"$W/scan.out" 2>"$W/scan.err" || rc=$?; echo "$rc:$(tr '\n' ' ' <"$W/scan.out")"; }
check "initramfs scan: early archives + zstd main without casper -> complete, nothing found" [ "$(scan initrd-clean.img)" = "0:" ]
check "initramfs scan: zstd main with scripts/casper* -> both names" [ "$(scan initrd-casper.img)" = "0:scripts/casper scripts/casper-bottom/25adduser " ]
check "initramfs scan: gzip main with scripts/casper* -> found" [ "$(scan initrd-gzip-casper.img)" = "0:scripts/casper scripts/casper-bottom/25adduser " ]
check "initramfs scan: truncated compressed archive -> unreadable (exit 2), never « clean »" [ "$(scan initrd-truncated.img | cut -d: -f1)" = 2 ]
check "initramfs scan: unknown data after the early archive -> unreadable (exit 2)" [ "$(scan initrd-garbage.img | cut -d: -f1)" = 2 ]
check "initramfs scan: truncated early archive -> unreadable (exit 2)" [ "$(scan initrd-cut-early.img | cut -d: -f1)" = 2 ]

# ====================================================================== GRUB wrapper (no loop device)
echo "== GRUB updates next to another system: /usr/local/sbin/grub-install adds --no-extra-removable"
sed -n "/^write_grub_wrapper() {/,/^}/p" "$HELPER" | sed -n "/<<'EOF'/,/^EOF\$/p" | sed '1d;$d' >"$W/grub-wrapper"
printf '#!/bin/sh\nprintf "%%s|" "$@"\n' >"$W/fake-grub-install"; chmod +x "$W/fake-grub-install"
sed "s|^real=/usr/sbin/grub-install\$|real=$W/fake-grub-install|" "$W/grub-wrapper" >"$W/grub-wrapper-test"; chmod +x "$W/grub-wrapper-test"
check "wrapper: calls /usr/sbin/grub-install (test copy: a fake that prints its arguments)" bash -c 'grep -qx "real=/usr/sbin/grub-install" "$1" && grep -q "fake-grub-install" "$2"' _ "$W/grub-wrapper" "$W/grub-wrapper-test"
check "wrapper: --target=x86_64-efi -> --no-extra-removable added, --force-extra-removable dropped" \
  [ "$("$W/grub-wrapper-test" --target=x86_64-efi --efi-directory=/boot/efi --force-extra-removable --bootloader-id=ubuntu)" = "--target=x86_64-efi|--efi-directory=/boot/efi|--bootloader-id=ubuntu|--no-extra-removable|" ]
check "wrapper: --target x86_64-efi (two words) -> --no-extra-removable added" [ "$("$W/grub-wrapper-test" --target x86_64-efi --recheck)" = "--target|x86_64-efi|--recheck|--no-extra-removable|" ]
check "wrapper: --target=i386-pc -> arguments unchanged" [ "$("$W/grub-wrapper-test" --target=i386-pc /dev/sda)" = "--target=i386-pc|/dev/sda|" ]
check "wrapper: arguments with spaces kept" [ "$("$W/grub-wrapper-test" --target=x86_64-efi '--bootloader-id=a b')" = "--target=x86_64-efi|--bootloader-id=a b|--no-extra-removable|" ]
check "wrapper: written only by the install « à côté » when the disk has EFI/BOOT (one call, in stage_bootloader_alongside; none in erase mode)" \
  bash -c '[[ $(grep -c "write_grub_wrapper" "$1") == 2 ]] && sed -n "/^stage_bootloader_alongside() {/,/^}/p" "$1" | grep -q "^  ((ESP_OWN_FALLBACK)) || write_grub_wrapper" && ! sed -n "/^stage_bootloader() {/,/^}/p" "$1" | grep -q write_grub_wrapper' _ "$HELPER"

# ====================================================================== images
echo "== building the test disks in $W"
rm -f "$W"/win.img "$W"/arch.img "$W"/cachy.img
truncate -s 64G "$W/win.img"
sfdisk -q "$W/win.img" <<'EOF'
label: gpt
size=100MiB, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, name="EFI system partition"
size=16MiB, type=E3C9E316-0B5C-4DB8-817D-F92DF00215AE, name="Microsoft reserved partition"
size=64300MiB, type=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7, name="Basic data partition"
type=DE94BBA4-06D1-4D40-A16A-BFD50179D6AC, name="Recovery"
EOF
attach "$W/win.img"; WIN=$ATTACHED
ours "${WIN}p1"; mkfs.vfat -F 32 -n SYSTEM "${WIN}p1" >/dev/null
mmd -i "${WIN}p1" ::/EFI ::/EFI/Microsoft ::/EFI/Microsoft/Boot ::/EFI/Boot
rand "$W/bootmgfw.efi" 1500000; rand "$W/BCD" 32768; rand "$W/bootx64.efi" 1500000
mcopy -i "${WIN}p1" "$W/bootmgfw.efi" "$W/BCD" ::/EFI/Microsoft/Boot/
mcopy -i "${WIN}p1" "$W/bootx64.efi" ::/EFI/Boot/bootx64.efi
ours "${WIN}p3"; mkntfs -Q -L Windows -p 239616 "${WIN}p3" >/dev/null 2>&1
ours "${WIN}p4"; mkntfs -Q -L Recovery "${WIN}p4" >/dev/null 2>&1
dd if=/dev/urandom of="${WIN}p2" bs=1M count=16 status=none   # MSR: random bytes (must stay identical)
# NTFS content through ntfs-3g (FUSE); fall back to ntfscp (root folder only) where FUSE is not available.
NT=$W/ntfs-mnt; mkdir -p "$NT"
if ntfs-3g "${WIN}p3" "$NT" 2>/dev/null; then
  MNTS+=("$NT")
  mkdir -p "$NT/Windows/System32" "$NT/Users/Anna/Documents" "$NT/Users/Anna/Pictures"
  rand "$NT/Windows/System32/ntoskrnl.exe" 8000000
  for i in 1 2 3 4 5; do rand "$NT/Users/Anna/Documents/doc$i.bin" 3000000; rand "$NT/Users/Anna/Pictures/photo$i.jpg" 5000000; done
  printf 'Bonjour\n' >"$NT/Users/Anna/Documents/lisez-moi é.txt"
  (cd "$NT" && find . -type f -print0 | sort -z | xargs -0 sha256sum) >"$W/win-files.sha256"
  umount "$NT"
  NTFS_TREE=1
else
  NTFS_TREE=0
  for i in 1 2 3; do rand "$W/doc$i.bin" 4000000; ntfscp -f "${WIN}p3" "$W/doc$i.bin" "doc$i.bin" >/dev/null; done
  (cd "$W" && sha256sum doc1.bin doc2.bin doc3.bin | sed 's|  |  ./|') >"$W/win-files.sha256"
fi
rand "$W/rec.wim" 3000000; ntfscp -f "${WIN}p4" "$W/rec.wim" winre.wim >/dev/null

truncate -s 80G "$W/arch.img"
sfdisk -q "$W/arch.img" <<'EOF'
label: gpt
size=512MiB, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B
size=50GiB, type=4F68BCE3-E8CD-4DB1-96E7-FBCAF984B709, name="arch"
EOF
attach "$W/arch.img"; ARCH=$ATTACHED
ours "${ARCH}p1"; mkfs.vfat -F 32 "${ARCH}p1" >/dev/null
mmd -i "${ARCH}p1" ::/EFI ::/EFI/arch ::/EFI/BOOT ::/loader ::/loader/entries
rand "$W/grubx64.efi" 200000; rand "$W/BOOTX64.EFI" 200000; rand "$W/vmlinuz-linux" 12000000
printf 'title   Arch Linux\nlinux   /vmlinuz-linux\noptions root=LABEL=arch rw\n' >"$W/arch.conf"
mcopy -i "${ARCH}p1" "$W/grubx64.efi" ::/EFI/arch/; mcopy -i "${ARCH}p1" "$W/BOOTX64.EFI" ::/EFI/BOOT/
mcopy -i "${ARCH}p1" "$W/arch.conf" ::/loader/entries/; mcopy -i "${ARCH}p1" "$W/vmlinuz-linux" ::/
AR=$W/arch-root; rm -rf "$AR"; mkdir -p "$AR/usr/lib" "$AR/etc" "$AR/home/anna/Documents" "$AR/home/anna/Musique"
printf 'NAME="Arch Linux"\nPRETTY_NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n' >"$AR/usr/lib/os-release"
ln -s ../usr/lib/os-release "$AR/etc/os-release"
for i in 1 2 3 4; do rand "$AR/home/anna/Documents/f$i.bin" 4000000; rand "$AR/home/anna/Musique/m$i.flac" 6000000; done
(cd "$AR" && find . -type f -print0 | sort -z | xargs -0 sha256sum) >"$W/arch-files.sha256"
ours "${ARCH}p2"; mkfs.ext4 -q -F -L arch -d "$AR" "${ARCH}p2"

esp_files() { # esp_files PART -> "sha256  path" of every file on a FAT partition (read with mtools)
  local d; d=$(mktemp -d "$W/espdump.XXXX")
  mcopy -s -n -m -Q -i "$1" '::*' "$d/" >/dev/null 2>&1
  (cd "$d" && find . -type f -print0 | sort -z | xargs -0r sha256sum)
  rm -rf "$d"
}
ntfs_files() { # ntfs_files PART -> sha256 of the files listed in win-files.sha256 (checked by sha256sum -c)
  if ((NTFS_TREE)); then
    ntfs-3g -o ro "$1" "$NT" || return 1
    (cd "$NT" && sha256sum --quiet -c "$W/win-files.sha256"); local rc=$?
    umount "$NT"; return $rc
  else
    local f; while read -r _ f; do ntfscat "$1" "${f#./}" | sha256sum -c --quiet <(grep -F "  $f" "$W/win-files.sha256" | sed "s|  .*|  -|") || return 1; done <"$W/win-files.sha256"
  fi
}
ext4_files() { # ext4_files PART [SUMS] -> checks SUMS (default arch-files.sha256) on a read-only mount
  local m=$W/ext4-mnt sums=${2:-$W/arch-files.sha256}; mkdir -p "$m"; MNTS+=("$m")
  mount -t ext4 -o ro,noload "$1" "$m" || return 1
  (cd "$m" && sha256sum --quiet -c "$sums"); local rc=$?
  umount "$m"; return $rc
}
WIN_ESP_FILES=$(esp_files "${WIN}p1")
WIN_ESP_RAW=$(rawsum "${WIN}p1") WIN_MSR_RAW=$(rawsum "${WIN}p2") WIN_REC_RAW=$(rawsum "${WIN}p4") ARCH_ESP_RAW=$(rawsum "${ARCH}p1")
check "test disks built (Windows-like ${WIN}, Arch-like ${ARCH}); files written: $(wc -l <"$W/win-files.sha256") NTFS, $(wc -l <"$W/arch-files.sha256") ext4" true

# ====================================================================== probe
echo "== probe (read-only)"
WIN_FP0=$(fp "$WIN") ARCH_FP0=$(fp "$ARCH")
"$PROBE" --disk "$WIN" --disk "$ARCH" --assume-uefi >"$W/probe.json"
check "probe: both disks surveyed" [ "$(jget "$W/probe.json" 'len(d["disks"])')" = 2 ]
pw="next(x for x in d['disks'] if x['path']=='$WIN')"; pa="next(x for x in d['disks'] if x['path']=='$ARCH')"
check "probe: GPT, fingerprint = sha256 of sfdisk --dump" [ "$(jget "$W/probe.json" "${pw}['table'] + ' ' + ${pw}['fingerprint']")" = "gpt $WIN_FP0" ]
check "probe: Windows ESP found (Microsoft + Boot folders, removable fallback present, no EFI/ubuntu)" \
  [ "$(jget "$W/probe.json" "(${pw}['esp']['number'], ${pw}['esp']['hasFallback'], ${pw}['esp']['ubuntuFolder'], sorted(f.lower() for f in ${pw}['esp']['folders']))")" = "(1, True, False, ['boot', 'microsoft'])" ]
check "probe: Windows detected (ESP Microsoft folder and the NTFS Windows folder)" \
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); w=[x for x in d["disks"] if x["path"]==sys.argv[2]][0]; n=[s["name"] for s in w["systems"]]; sys.exit(0 if "Windows Boot Manager" in n and (sys.argv[3]=="0" or "Windows" in n) else 1)' "$W/probe.json" "$WIN" "$NTFS_TREE"
check "probe: NTFS used space and shrink bounds (min >= used + 5 GB, max leaves 20 GB)" \
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); w=[x for x in d["disks"] if x["path"]==sys.argv[2]][0]; p=[x for x in w["partitions"] if x["number"]==3][0]; s=p["shrink"]; ok=s["possible"] and p["usedMiB"]>10 and s["minSizeMiB"]*1048576>=p["used"]+5e9 and s["maxSizeMiB"]<=p["sizeMiB"]-19074; print(p["usedMiB"], s); sys.exit(0 if ok else 1)' "$W/probe.json" "$WIN"
check "probe: ESP, MSR and recovery are never shrink candidates" \
  [ "$(jget "$W/probe.json" "[p['shrink']['possible'] for p in ${pw}['partitions'] if p['number'] != 3]")" = "[False, False, False]" ]
check "probe: Windows disk alongside possible by shrinking only (no free space)" \
  [ "$(jget "$W/probe.json" "(${pw}['alongside']['possible'], [x['kind'] for x in ${pw}['alongside']['plans']])")" = "(True, ['shrink'])" ]
check "probe: Arch disk — systemd-boot entry and os-release (Arch Linux), free space ~29.5 GiB, ext4 shrinkable" \
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); a=[x for x in d["disks"] if x["path"]==sys.argv[2]][0]; n=[s["name"] for s in a["systems"]]; k=sorted(x["kind"] for x in a["alongside"]["plans"]); f=a["free"][-1]; print(n, k, f); sys.exit(0 if "Arch Linux" in n and k==["free","shrink"] and f["sizeMiB"]>=30000 and f["startMiB"]%1==0 else 1)' "$W/probe.json" "$ARCH"
"$HELPER" --probe --json --disk "$WIN" --disk "$ARCH" >"$W/probe-ui.json"
check "aurora-install --probe: one {\"probe\":…} line (bytes, type, state, used/min, esp free/dirs/fallback)" \
  python3 -I -c 'import json,sys; o=json.loads(open(sys.argv[1]).read()); d=o["probe"]; w=[x for x in d["disks"] if x["path"]==sys.argv[2]][0]; t=[p["type"] for p in w["partitions"]]; e=w["partitions"][0]["esp"]; print(d["firmware"], t, e); sys.exit(0 if d["firmware"]=="uefi" and t==["esp","msr","windows","windows-recovery"] and e["fallback"] and e["free"]>32*1048576 and w["partitions"][2]["state"]=="ok" and w["partitions"][2]["min"]>0 and len(w["fingerprint"])==64 else 1)' "$W/probe-ui.json" "$WIN"
check "installer.js reads the helper's survey: Windows -> shrink offered; Arch -> free space + shrink" \
  node -e '
    const be = require(process.argv[1]); const fs = require("fs");
    let w, a;
    if (be.analyzeDisk && be.parseSurvey) {
      const sv = be.parseSurvey(fs.readFileSync(process.argv[2], "utf8"));
      w = be.analyzeDisk(sv.disks.find((x) => x.path === process.argv[3]), sv);
      a = be.analyzeDisk(sv.disks.find((x) => x.path === process.argv[4]), sv);
    } else {
      const o = be.parseProbe(fs.readFileSync(process.argv[5], "utf8"));
      w = be.planAlongside(o.disks.find((x) => x.path === process.argv[3]), o.firmware);
      a = be.planAlongside(o.disks.find((x) => x.path === process.argv[4]), o.firmware);
    }
    console.log(JSON.stringify({ w: [w.possible, w.reason, w.options.map((x) => x.method)], a: [a.possible, a.options.map((x) => x.method)], sys: (a.systems || []).map((s) => s.name) }));
    process.exit(w.possible && w.options.some((x) => x.method === "shrink") && a.possible && a.options.some((x) => x.method === "free") ? 0 : 1);' \
  "$HERE/shell/main/ipc/installer.js" "$W/probe.json" "$WIN" "$ARCH" "$W/probe-ui.json"
"$PROBE" --disk "$WIN" >"$W/probe-bios.json"
check "probe: legacy BIOS boot -> alongside refused (reason bios)" [ "$(jget "$W/probe-bios.json" "d['disks'][0]['alongside']['reason']")" = bios ]
check "probe wrote nothing (partition tables unchanged)" [ "$(fp "$WIN") $(fp "$ARCH")" = "$WIN_FP0 $ARCH_FP0" ]

# Hibernated Windows / Fast Startup: hiberfil.sys starting with HIBR.
printf 'HIBR' >"$W/hiberfil.sys"; head -c 8188 /dev/zero >>"$W/hiberfil.sys"
ntfscp -f "${WIN}p3" "$W/hiberfil.sys" hiberfil.sys >/dev/null
"$PROBE" --disk "$WIN" --assume-uefi >"$W/probe-hib.json"
check "probe: hibernated / Fast Startup Windows -> not shrinkable, alongside reason hibernated (partition 3)" \
  [ "$(jget "$W/probe-hib.json" "([p['shrink']['reason'] for p in d['disks'][0]['partitions'] if p['number']==3][0], d['disks'][0]['alongside']['reason'], d['disks'][0]['alongside'].get('partition'))")" = "('hibernated', 'hibernated', 3)" ]
WIN_FP=$(fp "$WIN")
rc=0; run_install "$W/out-hib.json" "$WIN" --alongside --esp 1 --fingerprint "$WIN_FP" --shrink 3 --new-size 30000 --fail-at copy || rc=$?
check "install refused on a hibernated Windows (exit 4), table unchanged" [ "$rc:$(fp "$WIN")" = "4:$WIN_FP" ]
grep -q 'Fast Startup' "$W/out-hib.json" && pass "the refusal says to turn off Fast Startup" || fail "no Fast Startup advice: $(cat "$W/out-hib.json")"
# Windows shut down fully: no saved session (ntfs-3g's remove_hiberfile deletes hiberfil.sys, as Windows would reset it).
if ntfs-3g -o remove_hiberfile "${WIN}p3" "$NT" 2>/dev/null; then umount "$NT"; else fail "could not clear the test hibernation"; fi

# ====================================================================== refusals (nothing written)
echo "== refusals"
WIN_FP=$(fp "$WIN")
refused() { # refused DESC EXPECTED_RC ARGS... : the helper exits with EXPECTED_RC and the table is unchanged
  local d=$1 want=$2 rc=0; shift 2
  run_install "$W/out-refused.json" "$WIN" "$@" || rc=$?
  if [[ "$rc" == "$want" && "$(fp "$WIN")" == "$WIN_FP" && "$(rawsum "${WIN}p1")" == "$WIN_ESP_RAW" ]]; then pass "$d (exit $rc, nothing written)"
  else fail "$d: exit $rc $(tail -c 300 "$W/out-refused.json")"; fi
}
refused "changed partition table (wrong fingerprint)" 4 --alongside --esp 1 --fingerprint "$ARCH_FP0" --shrink 3 --new-size 30000
refused "shrink below the minimum (used + max(5 GiB, 10 %))" 4 --alongside --esp 1 --fingerprint "$WIN_FP" --shrink 3 --new-size 2000
refused "shrink that leaves less than 20 GiB for Selene" 4 --alongside --esp 1 --fingerprint "$WIN_FP" --shrink 3 --new-size 50000
refused "shrink the Microsoft reserved partition" 4 --alongside --esp 1 --fingerprint "$WIN_FP" --shrink 2 --new-size 1024
refused "free space that does not exist" 4 --alongside --esp 1 --fingerprint "$WIN_FP" --free-space 200:30000
refused "wrong EFI system partition" 4 --alongside --esp 4 --fingerprint "$WIN_FP" --shrink 3 --new-size 30000
refused "Selene smaller than 20 GiB" 2 --alongside --esp 1 --fingerprint "$WIN_FP" --free-space 200:10000
refused "the ESP as the partition to shrink" 2 --alongside --esp 1 --fingerprint "$WIN_FP" --shrink 1 --new-size 30000
refused "invalid partition number" 2 --alongside --esp 1 --fingerprint "$WIN_FP" --shrink 300 --new-size 30000
refused "shell metacharacters in a size" 2 --alongside --esp 1 --fingerprint "$WIN_FP" --shrink 3 --new-size '30000;reboot'
refused "--shrink without --alongside" 2 --shrink 3 --new-size 30000
refused "other spelling: Selene larger than the space freed (--shrink-to + --root-size)" 4 --alongside --esp 1 --expect-table "$WIN_FP" --shrink 3 --shrink-to 30000 --root-size 40000
refused "other spelling: --free-start without --root-size" 2 --alongside --esp 1 --expect-table "$WIN_FP" --free-start 200
rc=0; AURORA_INSTALL_TEST_NO_FIRMWARE=0 run_install "$W/out-bios.json" "$WIN" --alongside --esp 1 --fingerprint "$WIN_FP" --shrink 3 --new-size 30000 || rc=$?
check "install alongside refused when the computer started in BIOS mode (exit 4, nothing written)" [ "$rc:$(fp "$WIN")" = "4:$WIN_FP" ]

# ====================================================================== NTFS shrink (Windows)
echo "== Windows: shrink NTFS 64300 -> 30000 MiB, Selene takes the 34300 MiB freed (stopped after the format stage)"
OLD_DUMP=$(sfdisk --dump "$WIN")
rc=0; run_install "$W/out-win.json" "$WIN" --alongside --esp 1 --fingerprint "$WIN_FP" --shrink 3 --new-size 30000 --fail-at copy || rc=$?
check "aurora-install --alongside --shrink 3: shrink + partition + format done, stopped at copy (exit 5 from --fail-at)" \
  bash -c '[[ $1 == 5 ]] && grep -q "Shrinking" "$2" && grep -q "simulated failure at stage .copy." "$2"' _ "$rc" "$W/out-win.json"
partx -u "$WIN" >/dev/null 2>&1 || true
NEW=$(sfdisk --dump "$WIN")
p3=$(grep "^${WIN}p3 " <<<"$NEW"); p5=$(grep "^${WIN}p5 " <<<"$NEW" || true)
check "NTFS partition entry now 30000 MiB, same start / type / UUID / name" \
  [ "$(sed 's/size= *[0-9]*/size=X/' <<<"$p3")" = "$(grep "^${WIN}p3 " <<<"$OLD_DUMP" | sed 's/size= *[0-9]*/size=X/')" -a "$(sed -n 's/.*size= *\([0-9]*\),.*/\1/p' <<<"$p3")" = $((30000 * 2048)) ]
s5=$(sed -n 's/.*start= *\([0-9]*\),.*/\1/p' <<<"$p5"); z5=$(sed -n 's/.*size= *\([0-9]*\),.*/\1/p' <<<"$p5")
s3=$(sed -n 's/.*start= *\([0-9]*\),.*/\1/p' <<<"$p3")
check "new partition p5 « Selene OS »: 34300 MiB, 1 MiB aligned, right after the shrunk NTFS, Linux type" \
  bash -c '[[ -n $1 && $(($2 % 2048)) == 0 && $3 == $((34300 * 2048)) && $2 -ge $(($4 + 30000 * 2048)) && $2 -lt $(($4 + 30000 * 2048 + 2048)) && $1 == *0FC63DAF-8483-4772-8E79-3D69D8477DE4* && $1 == *"Selene OS"* ]]' _ "$p5" "$s5" "$z5" "$s3"
check "every other partition entry unchanged (ESP, MSR, recovery)" \
  [ "$(grep -E "^${WIN}p[124] " <<<"$NEW")" = "$(grep -E "^${WIN}p[124] " <<<"$OLD_DUMP")" ]
check "ESP, MSR and recovery partitions byte-identical" [ "$(rawsum "${WIN}p1") $(rawsum "${WIN}p2") $(rawsum "${WIN}p4")" = "$WIN_ESP_RAW $WIN_MSR_RAW $WIN_REC_RAW" ]
vs=$(ntfsresize --info --force --no-progress-bar "${WIN}p3" 2>/dev/null | sed -n 's/^Current volume size: *\([0-9]*\) bytes.*/\1/p')
check "NTFS file system fits its partition ($vs <= $((30000 * 1048576)) bytes)" [ "${vs:-0}" -gt 0 -a "${vs:-0}" -le $((30000 * 1048576)) ]
check "every NTFS file intact after the shrink (sha256)" ntfs_files "${WIN}p3"
check "new partition formatted ext4, label AURORA" [ "$(blkid -p -s TYPE -o value "${WIN}p5") $(blkid -p -s LABEL -o value "${WIN}p5")" = "ext4 AURORA" ]
check "the partition table before the change is in the log" grep -qF "$(grep "^${WIN}p3 " <<<"$OLD_DUMP")" "$W/install.log"
check "sfdisk --verify: no errors" sfdisk --verify "$WIN" >/dev/null

# ====================================================================== free space (Arch)
echo "== Arch: install in the free space (Selene 25000 MiB of the ~29.5 GiB; --free-start/--root-size spelling)"
ARCH_FP=$(fp "$ARCH")
fstart=$(jget "$W/probe.json" "${pa}['free'][-1]['startMiB']")
OLD_DUMP=$(sfdisk --dump "$ARCH")
rc=0; run_install "$W/out-arch.json" "$ARCH" --alongside --esp 1 --expect-table "$ARCH_FP" --free-start "$fstart" --root-size 25000 --fail-at copy || rc=$?
check "aurora-install --alongside --free-start $fstart --root-size 25000: partition + format, stopped at copy" grep -q 'simulated failure at stage .copy.' "$W/out-arch.json"
NEW=$(sfdisk --dump "$ARCH"); p3=$(grep "^${ARCH}p3 " <<<"$NEW" || true)
check "new partition p3 at ${fstart} MiB, 25000 MiB, aligned" bash -c '[[ $1 == *"start= $(($2 * 2048)),"* || $1 =~ start=\ +$(($2 * 2048)), ]] && [[ $1 =~ size=\ +$((25000 * 2048)), ]]' _ "$p3" "$fstart"
check "Arch partitions unchanged (entries, ESP bytes, ext4 files)" \
  bash -c '[[ "$1" == "$2" ]]' _ "$(grep -E "^${ARCH}p[12] " <<<"$NEW")" "$(grep -E "^${ARCH}p[12] " <<<"$OLD_DUMP")"
check "Arch ESP byte-identical" [ "$(rawsum "${ARCH}p1")" = "$ARCH_ESP_RAW" ]
check "Arch ext4 files intact" ext4_files "${ARCH}p2"

echo "== Arch: shrink ext4 51200 -> 25000 MiB, Selene 20000 MiB of the 26200 MiB freed (--shrink-to/--root-size spelling)"
ARCH_FP=$(fp "$ARCH"); OLD_DUMP=$NEW
rc=0; run_install "$W/out-arch2.json" "$ARCH" --alongside --esp 1 --expect-table "$ARCH_FP" --shrink 2 --shrink-to 25000 --root-size 20000 --fail-at copy || rc=$?
check "aurora-install --alongside --shrink 2 (ext4): e2fsck + resize2fs, stopped at copy" grep -q 'simulated failure at stage .copy.' "$W/out-arch2.json"
NEW=$(sfdisk --dump "$ARCH"); p2=$(grep "^${ARCH}p2 " <<<"$NEW"); p4=$(grep "^${ARCH}p4 " <<<"$NEW" || true)
check "ext4 partition entry now 25000 MiB; Selene p4 20000 MiB aligned after it" \
  bash -c '[[ $1 =~ size=\ +$((25000 * 2048)), && $2 =~ size=\ +$((20000 * 2048)), && $2 == *"Selene OS"* ]]' _ "$p2" "$p4"
bc=$(dumpe2fs -h "${ARCH}p2" 2>/dev/null | sed -n 's/^Block count: *//p'); bsz=$(dumpe2fs -h "${ARCH}p2" 2>/dev/null | sed -n 's/^Block size: *//p')
check "ext4 file system fits its partition ($((bc * bsz)) <= $((25000 * 1048576)))" [ $((bc * bsz)) -le $((25000 * 1048576)) ]
check "e2fsck -f -n clean after the shrink" e2fsck -f -n "${ARCH}p2" >/dev/null 2>&1
check "Arch ext4 files intact after the shrink" ext4_files "${ARCH}p2"
check "first Selene partition (p3) and the ESP unchanged" \
  bash -c '[[ "$1" == "$2" && "$3" == "$4" ]]' _ "$(grep -E "^${ARCH}p[13] " <<<"$NEW")" "$(grep -E "^${ARCH}p[13] " <<<"$OLD_DUMP")" "$(rawsum "${ARCH}p1")" "$ARCH_ESP_RAW"

# ====================================================================== full installation (optional)
if [[ -n "$FULL" ]]; then
  echo "== full installation next to Windows from $FULL (copy, configure, boot loader on the shared ESP)"
  # The Windows-like disk is reused: the Selene OS partition from above is removed first (sfdisk --delete, our loop only).
  ours "$WIN"; sfdisk --quiet --delete "$WIN" 5 >/dev/null 2>&1; partx -d --nr 5 "$WIN" >/dev/null 2>&1 || true; partx -u "$WIN" >/dev/null 2>&1 || true
  "$PROBE" --disk "$WIN" --assume-uefi >"$W/probe-full.json"
  WIN_FP=$(fp "$WIN"); fstart=$(jget "$W/probe-full.json" "d['disks'][0]['free'][0]['startMiB']"); fend=$(jget "$W/probe-full.json" "d['disks'][0]['free'][0]['endMiB']")
  ours "$WIN"
  mapfile -t base < <(install_args "$WIN" | sed "s|^$FAKE_SRC\$|$FULL|; s|^$W\$|$(dirname "$(dirname "$FULL")")|")
  # 1) a boot loader stage that replaces the other system's EFI/BOOT/BOOTX64.EFI: the ESP must come back as it was.
  rc=0
  echo 'pw-test-123' | AURORA_INSTALL_TEST_TAMPER_ESP=1 "$HELPER" "${base[@]}" --alongside --esp 1 --fingerprint "$WIN_FP" --free-space "$fstart:$fend" >"$W/out-tamper.json" 2>>"$W/install.stderr" || rc=$?
  check "EFI/BOOT replaced during the boot loader stage: installation fails (exit 5) with a clear message" \
    bash -c '[[ $1 == 5 ]] && grep -q "original files were put back byte for byte" "$2"' _ "$rc" "$W/out-tamper.json"
  check "ESP after the failure: exactly the files before (bootmgfw.efi, BCD, EFI/Boot/bootx64.efi byte for byte; no EFI/ubuntu, no fbx64.efi)" \
    bash -c '[[ "$1" == "$2" ]]' _ "$(esp_files "${WIN}p1")" "$WIN_ESP_FILES"
  check "ESP folders after the failure: no EFI/ubuntu left (a retry is not refused for « ubuntu-folder »)" bash -c '! mdir -b -i "$1" ::/EFI 2>/dev/null | grep -qi "/ubuntu"' _ "${WIN}p1"
  check "the ESP copy in /run is removed once put back" bash -c '! compgen -G "/run/aurora-esp-backup.*" >/dev/null'
  check "the log tells what was put back and removed" bash -c 'grep -qi "restoring EFI/Boot/bootx64.efi on the EFI system partition" "$1" && grep -qi "removing EFI/Boot/fbx64.efi" "$1"' _ "$W/install.log"
  # The failed run left its Selene OS partition: removed (our loop device only), then the normal installation.
  ours "$WIN"; sfdisk --quiet --delete "$WIN" 5 >/dev/null 2>&1; partx -d --nr 5 "$WIN" >/dev/null 2>&1 || true; partx -u "$WIN" >/dev/null 2>&1 || true
  check "partition table back to the one before the failed run" [ "$(fp "$WIN")" = "$WIN_FP" ]
  # 2) the normal installation.
  rc=0
  echo 'pw-test-123' | "$HELPER" "${base[@]}" --alongside --esp 1 --fingerprint "$WIN_FP" --free-space "$fstart:$fend" >"$W/out-full.json" 2>>"$W/install.stderr" || rc=$?
  check "full installation next to Windows: exit 0, done" bash -c '[[ $1 == 0 ]] && grep -q "\"stage\":\"done\"" "$2"' _ "$rc" "$W/out-full.json"
  check "boot entry reported as skipped in test mode" grep -q '"bootentry":"skipped"' "$W/out-full.json"
  after=$(esp_files "${WIN}p1")
  check "ESP: every Windows file unchanged (bootmgfw.efi, BCD, EFI/Boot/bootx64.efi)" bash -c '[[ "$(grep -vi "/efi/ubuntu/" <<<"$1")" == "$2" ]]' _ "$after" "$WIN_ESP_FILES"
  check "ESP: EFI/ubuntu added (shimx64.efi, grubx64.efi, grub.cfg)" bash -c 'grep -qi "/efi/ubuntu/shimx64.efi" <<<"$1" && grep -qi "/efi/ubuntu/grubx64.efi" <<<"$1" && grep -qi "/efi/ubuntu/grub.cfg" <<<"$1"' _ "$after"
  m=$W/sel-mnt; mkdir -p "$m"; MNTS+=("$m"); mount -t ext4 -o ro "${WIN}p5" "$m"
  check "installed: GRUB_DISABLE_OS_PROBER=false, 5 s menu" grep -q '^GRUB_DISABLE_OS_PROBER=false' "$m/etc/default/grub.d/50-aurora.cfg"
  check "installed: fstab mounts the shared ESP by UUID" grep -q "UUID=$(blkid -p -s UUID -o value "${WIN}p1") */boot/efi" "$m/etc/fstab"
  check "installed: the partition table before the change is kept in /var/log" test -s "$m/var/log/aurora-install-partitions.sfdisk"
  check "installed: /usr/local/sbin/grub-install wrapper (Windows' disk has EFI/Boot): executable, adds --no-extra-removable" \
    bash -c '[[ -x $1 ]] && grep -q -- "--no-extra-removable" "$1" && cmp -s "$1" "$2"' _ "$m/usr/local/sbin/grub-install" "$W/grub-wrapper"
  check "installed: debconf grub2/no_efi_extra_removable true, grub2/force_efi_extra_removable false" \
    python3 -I -c 'import sys; t=open(sys.argv[1]).read().split("\n\n"); g=lambda n: [b for b in t if ("Name: grub2/"+n+"\n") in b+"\n"]; sys.exit(0 if any("Value: true" in b for b in g("no_efi_extra_removable")) and any("Value: false" in b for b in g("force_efi_extra_removable")) else 1)' "$m/var/cache/debconf/config.dat"
  check "installed: initramfs checked by the python3 scan (no lsinitramfs) and free of casper" bash -c 'grep -q "\] initramfs: " "$1" && ! grep -q "using lsinitramfs" "$1"' _ "$W/install.log"
  umount "$m"
  check "NTFS files still intact after the full installation" ntfs_files "${WIN}p3"
  ours "${WIN}p5"; blkdiscard -f "${WIN}p5" >/dev/null 2>&1 || true   # gives the image's blocks back (disk space)
fi

# ====================================================================== CachyOS + Limine (the user's PC, smaller)
echo "== CachyOS-like disk: GPT, 1 GiB ESP with Limine (kernels on the ESP, mounted at /boot), ext4 root, no free space"
truncate -s 40G "$W/cachy.img"
sfdisk -q "$W/cachy.img" <<'EOF'
label: gpt
size=1GiB, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, name="EFI System"
type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name="Linux filesystem"
EOF
attach "$W/cachy.img"; CACHY=$ATTACHED
CACHY_UUID=6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5 CACHY_ESP_UUID=1A2B-3C4D
ours "${CACHY}p1"; mkfs.vfat -F 32 -i 1A2B3C4D "${CACHY}p1" >/dev/null
mmd -i "${CACHY}p1" ::/EFI ::/EFI/limine ::/EFI/BOOT
if [[ -f /usr/share/limine/BOOTX64.EFI ]]; then cp /usr/share/limine/BOOTX64.EFI "$W/limine.efi"; else rand "$W/limine.efi" 90000; fi
rand "$W/cachy-bootx64.efi" 90000; rand "$W/vmlinuz-linux-cachyos" 14000000; rand "$W/initramfs-linux-cachyos.img" 20000000
printf 'timeout: 5\n\n/+CachyOS\n    comment: CachyOS linux-cachyos\n    //linux-cachyos\n        protocol: linux\n        kernel_path: boot():/vmlinuz-linux-cachyos\n        kernel_cmdline: root=UUID=%s rw quiet\n        module_path: boot():/initramfs-linux-cachyos.img\n' "$CACHY_UUID" >"$W/limine.conf"
mcopy -i "${CACHY}p1" "$W/limine.efi" ::/EFI/limine/BOOTX64.EFI; mcopy -i "${CACHY}p1" "$W/cachy-bootx64.efi" ::/EFI/BOOT/BOOTX64.EFI
mcopy -i "${CACHY}p1" "$W/limine.conf" "$W/vmlinuz-linux-cachyos" "$W/initramfs-linux-cachyos.img" ::/
CR=$W/cachy-root; rm -rf "$CR"; mkdir -p "$CR/etc" "$CR/boot" "$CR/home/anna/Documents" "$CR/home/anna/Images"
printf 'NAME=CachyOS\nPRETTY_NAME=CachyOS\nID=cachyos\nID_LIKE=arch\nBUILD_ID=rolling\n' >"$CR/etc/os-release"
printf '# /etc/fstab (CachyOS)\nUUID=%s  /      ext4  noatime  0 1\nUUID=%s  /boot  vfat  defaults,umask=0077  0 2\n' "$CACHY_UUID" "$CACHY_ESP_UUID" >"$CR/etc/fstab"
for i in 1 2 3; do rand "$CR/home/anna/Documents/c$i.bin" 4000000; rand "$CR/home/anna/Images/i$i.png" 5000000; done
(cd "$CR" && find . -type f -print0 | sort -z | xargs -0 sha256sum) >"$W/cachy-files.sha256"
ours "${CACHY}p2"; mkfs.ext4 -q -F -U "$CACHY_UUID" -d "$CR" "${CACHY}p2"
CACHY_ESP_FILES=$(esp_files "${CACHY}p1") CACHY_ESP_RAW=$(rawsum "${CACHY}p1")
ESP_PARTUUID=$(blkid -p -s PART_ENTRY_UUID -o value "${CACHY}p1")
# What `efibootmgr -v` shows on such a PC (efibootmgr 18 and older spellings): Limine first, the removable path, PXE.
cat >"$W/efibootmgr-cachy.txt" <<EOF
BootCurrent: 0001
Timeout: 0 seconds
BootOrder: 0001,0002,0003
Boot0001* Limine	HD(1,GPT,${ESP_PARTUUID},0x800,0x200000)/\\EFI\\limine\\BOOTX64.EFI
      dp: 04 01 2a 00 01 00 00 00 00 08 00 00 00 00 00 00 00 00 20 00 00 00 00 00
Boot0002* UEFI OS	HD(1,GPT,${ESP_PARTUUID},0x800,0x200000)/File(\\EFI\\BOOT\\BOOTX64.EFI)..BO
Boot0003* UEFI: PXE IPv4 Intel(R) Ethernet	PciRoot(0x0)/Pci(0x1f,0x6)/MAC(001122334455,0)/IPv4(0.0.0.0,0,DHCP)..BO
EOF
check "CachyOS disk built ($CACHY): ESP $CACHY_ESP_UUID with Limine + kernels, ext4 $CACHY_UUID with $(wc -l <"$W/cachy-files.sha256") files" true

"$PROBE" --disk "$CACHY" --assume-uefi >"$W/probe-cachy.json"
check "probe CachyOS: system « CachyOS » (linux, partition 2, /etc/os-release), ESP folders BOOT + limine, no free space, plan: shrink ext4 p2" \
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1]))["disks"][0]; n=[(s["name"],s["kind"],s["partition"]) for s in d["systems"] if not s.get("loader")]; p=[(x["kind"],x.get("partition"),x.get("fstype")) for x in d["alongside"]["plans"]]; print(n, p, d["free"], d["esp"]["folders"]); sys.exit(0 if n==[("CachyOS","linux",2)] and p==[("shrink",2,"ext4")] and not d["free"] and sorted(f.lower() for f in d["esp"]["folders"])==["boot","limine"] else 1)' "$W/probe-cachy.json"
check "probe CachyOS: chain = CachyOS (id cachyos, its fstab mounts the ESP on /boot, ext4 UUID, partition 2)" \
  python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1]))["disks"][0]["chain"]; print(c); sys.exit(0 if c=={"name":"CachyOS","id":"cachyos","uuid":sys.argv[2],"partition":2,"espOnBoot":True} else 1)' "$W/probe-cachy.json" "$CACHY_UUID"
check "installer.js: « Installer à côté de CachyOS », shrink ext4 offered, 5 s menu entry « CachyOS »" \
  node -e 'const be=require(process.argv[1]); const sv=be.parseSurvey(require("fs").readFileSync(process.argv[2],"utf8")); const a=be.analyzeDisk(sv.disks[0],sv); console.log(a.os, a.menuName, a.options.map((o)=>o.method+":"+o.fstype)); process.exit(a.possible && a.os==="CachyOS" && a.menuName==="CachyOS" && a.options.length===1 && a.options[0].method==="shrink" && a.options[0].fstype==="ext4" ? 0 : 1)' \
  "$HERE/shell/main/ipc/installer.js" "$W/probe-cachy.json"

# 1) An installation that stops: the ext4 root is shrunk, the Selene OS partition created (and, with --full, filled).
echo "== CachyOS: shrink ext4 -> 12000 MiB, Selene takes the space freed; the installation stops ($([[ -n "$FULL" ]] && echo 'at the boot loader, after copy + configure' || echo 'at copy'))"
CACHY_FP=$(fp "$CACHY"); OLD_DUMP=$(sfdisk --dump "$CACHY")
if [[ -n "$FULL" ]]; then
  mapfile -t cbase < <(install_args "$CACHY" | sed "s|^$FAKE_SRC\$|$FULL|; s|^$W\$|$(dirname "$(dirname "$FULL")")|"); stop=bootloader
else
  mapfile -t cbase < <(install_args "$CACHY"); stop=copy
fi
rc=0; echo 'pw-test-123' | "$HELPER" "${cbase[@]}" --alongside --esp 1 --fingerprint "$CACHY_FP" --shrink 2 --new-size 12000 --fail-at "$stop" >"$W/out-cachy1.json" 2>>"$W/install.stderr" || rc=$?
check "aurora-install --alongside --shrink 2 (ext4): shrunk, partitioned, formatted, stopped at $stop (exit 5)" \
  bash -c '[[ $1 == 5 ]] && grep -q "simulated failure at stage .$3." "$2"' _ "$rc" "$W/out-cachy1.json" "$stop"
check "the shrink message says it can take from a few minutes to an hour" grep -q 'this can take from a few minutes to an hour, depending on the data' "$W/out-cachy1.json"
partx -u "$CACHY" >/dev/null 2>&1 || true
NEW=$(sfdisk --dump "$CACHY"); p2=$(grep "^${CACHY}p2 " <<<"$NEW"); p3=$(grep "^${CACHY}p3 " <<<"$NEW" || true)
check "CachyOS entry now 12000 MiB (same start / type / UUID / name); « Selene OS » p3 after it" \
  bash -c '[[ "$(sed "s/size= *[0-9]*/size=X/" <<<"$1")" == "$(sed "s/size= *[0-9]*/size=X/" <<<"$2")" && $1 =~ size=\ +$((12000 * 2048)), && $3 == *"Selene OS"* ]]' _ "$p2" "$(grep "^${CACHY}p2 " <<<"$OLD_DUMP")" "$p3"
check "CachyOS ESP byte-identical after the stopped installation" [ "$(rawsum "${CACHY}p1")" = "$CACHY_ESP_RAW" ]
check "CachyOS ext4: e2fsck -f -n clean after the shrink" bash -c 'e2fsck -f -n "$1" >/dev/null 2>&1' _ "${CACHY}p2"
check "CachyOS ext4 files keep their checksums after the shrink" ext4_files "${CACHY}p2" "$W/cachy-files.sha256"
check "CachyOS ext4 UUID unchanged by the shrink (os-prober skip list / its own fstab)" [ "$(blkid -p -s UUID -o value "${CACHY}p2")" = "$CACHY_UUID" ]

# 2) The retry: the left « Selene OS » partition is offered again (nothing else changes).
echo "== CachyOS: retry — the probe offers the Selene OS partition left behind (plan reuse)"
"$PROBE" --disk "$CACHY" --assume-uefi >"$W/probe-cachy2.json"
check "probe after the stopped installation: plan « reuse » p3 first; p3 is neither a system nor shrinkable; CachyOS still the chain" \
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1]))["disks"][0]; pl=d["alongside"]["plans"]; p3=[p for p in d["partitions"] if p["number"]==3][0]; n=[s["name"] for s in d["systems"] if not s.get("loader")]; print([x["kind"] for x in pl], n, p3.get("reuse"), p3["shrink"]["possible"]); sys.exit(0 if pl and pl[0]["kind"]=="reuse" and pl[0]["partition"]==3 and p3.get("reuse") and not p3["shrink"]["possible"] and n==["CachyOS"] and d["chain"]["name"]=="CachyOS" else 1)' "$W/probe-cachy2.json"
check "installer.js: the reuse option first (its exact size), « Installer à côté de CachyOS »" \
  node -e 'const be=require(process.argv[1]); const sv=be.parseSurvey(require("fs").readFileSync(process.argv[2],"utf8")); const a=be.analyzeDisk(sv.disks[0],sv); const o=a.options[0]; console.log(a.os, a.options.map((x)=>x.method)); process.exit(a.possible && a.os==="CachyOS" && o.method==="reuse" && o.number===3 && o.rootMinMiB===o.sizeMiB ? 0 : 1)' \
  "$HERE/shell/main/ipc/installer.js" "$W/probe-cachy2.json"
CACHY_FP=$(fp "$CACHY"); P3_UUID_BEFORE=$(blkid -p -s UUID -o value "${CACHY}p3")
rc=0; echo 'pw-test-123' | "$HELPER" "${cbase[@]}" --alongside --esp 1 --fingerprint "$CACHY_FP" --reuse-partition 2 >"$W/out-cachy-bad.json" 2>>"$W/install.stderr" || rc=$?
check "--reuse-partition 2 (CachyOS itself) refused (exit 4), nothing written" [ "$rc:$(fp "$CACHY"):$(blkid -p -s UUID -o value "${CACHY}p2")" = "4:$CACHY_FP:$CACHY_UUID" ]
rc=0
if [[ -n "$FULL" ]]; then
  echo "== CachyOS: complete installation in the reused partition (boot loader on the shared ESP, injected efibootmgr -v)"
  echo 'pw-test-123' | AURORA_INSTALL_TEST_EFIBOOTMGR_V="$W/efibootmgr-cachy.txt" "$HELPER" "${cbase[@]}" --alongside --esp 1 --fingerprint "$CACHY_FP" --reuse-partition 3 >"$W/out-cachy2.json" 2>>"$W/install.stderr" || rc=$?
  check "full installation reusing p3: exit 0, done" bash -c '[[ $1 == 0 ]] && grep -q "\"stage\":\"done\"" "$2"' _ "$rc" "$W/out-cachy2.json"
else
  echo 'pw-test-123' | "$HELPER" "${cbase[@]}" --alongside --esp 1 --fingerprint "$CACHY_FP" --reuse-partition 3 --fail-at copy >"$W/out-cachy2.json" 2>>"$W/install.stderr" || rc=$?
  check "aurora-install --reuse-partition 3: formatted again, stopped at copy" bash -c '[[ $1 == 5 ]] && grep -q "Reusing the Selene OS partition of the previous attempt" "$2" && grep -q "simulated failure at stage .copy." "$2"' _ "$rc" "$W/out-cachy2.json"
fi
check "reuse: the partition table is not written (same fingerprint), p3 formatted again (ext4 AURORA, new UUID)" \
  bash -c '[[ $1 == "$2" && $3 == "ext4 AURORA" && -n $4 && $4 != "$5" ]]' _ "$(fp "$CACHY")" "$CACHY_FP" "$(blkid -p -s TYPE -o value "${CACHY}p3") $(blkid -p -s LABEL -o value "${CACHY}p3")" "$(blkid -p -s UUID -o value "${CACHY}p3")" "$P3_UUID_BEFORE"
check "CachyOS ext4 files intact after the retry" ext4_files "${CACHY}p2" "$W/cachy-files.sha256"
after=$(esp_files "${CACHY}p1")
check "CachyOS ESP: every file byte-identical except EFI/ubuntu (Limine, EFI/BOOT, limine.conf, kernels, initramfs)" \
  bash -c '[[ "$(grep -vi "/efi/ubuntu/" <<<"$1")" == "$2" ]]' _ "$after" "$CACHY_ESP_FILES"
if [[ -n "$FULL" ]]; then
  m=$W/cachy-sel; mkdir -p "$m"; MNTS+=("$m"); mount -t ext4 -o ro "${CACHY}p3" "$m"
  cfg=$m/boot/grub/grub.cfg
  check "installed: EFI/ubuntu added on the ESP (shimx64.efi, grubx64.efi)" bash -c 'grep -qi "/efi/ubuntu/shimx64.efi" <<<"$1" && grep -qi "/efi/ubuntu/grubx64.efi" <<<"$1"' _ "$after"
  check "installed: /etc/aurora/boot-chainload.list = one line « $CACHY_ESP_UUID /EFI/limine/BOOTX64.EFI CachyOS »" \
    [ "$(grep -v '^#' "$m/etc/aurora/boot-chainload.list")" = "$(printf '%s\t%s\t%s' "$CACHY_ESP_UUID" /EFI/limine/BOOTX64.EFI CachyOS)" ]
  check "installed: /etc/grub.d/25_aurora_chainload executable (update-grub keeps the entry)" test -x "$m/etc/grub.d/25_aurora_chainload"
  check "grub.cfg: exactly one « CachyOS » entry" [ "$(grep -c "^menuentry 'CachyOS' " "$cfg")" = 1 ]
  check "grub.cfg: it searches the ESP by UUID and chainloads /EFI/limine/BOOTX64.EFI" \
    python3 -I -c 'import re,sys; t=open(sys.argv[1]).read(); m=re.search(r"^menuentry .CachyOS. [^{]*\{\n(.*?)\n\}", t, re.S|re.M); b=m.group(1) if m else ""; print(b); sys.exit(0 if ("search --no-floppy --fs-uuid --set=root "+sys.argv[2]) in b and re.search(r"^\s*chainloader /EFI/limine/BOOTX64\.EFI$", b, re.M) and "linux" not in b else 1)' "$cfg" "$CACHY_ESP_UUID"
  check "grub.cfg: Selene OS first, then CachyOS; 5 s menu" \
    python3 -I -c 'import re,sys; t=re.findall(r"^menuentry .([^\x27]*).", open(sys.argv[1]).read(), re.M); print(t); sys.exit(0 if t[:2]==["Selene OS GNU/Linux","CachyOS"] and re.search(r"^GRUB_TIMEOUT=5$", open(sys.argv[2]).read(), re.M) else 1)' "$cfg" "$m/etc/default/grub.d/50-aurora.cfg"
  check "grub.cfg: no os-prober Linux entry (osprober-gnulinux), nothing booting vmlinuz-linux-cachyos directly" bash -c '! grep -q "osprober-gnulinux\|vmlinuz-linux-cachyos" "$1"' _ "$cfg"
  skip=$( . "$m/etc/default/grub.d/51-aurora-chainload.cfg"; printf '%s' "$GRUB_OS_PROBER_SKIP_LIST")
  check "installed: GRUB_OS_PROBER_SKIP_LIST = the CachyOS partition's UUID and UUID@device (the key 30_os-prober compares)" [ "$skip" = "$CACHY_UUID $CACHY_UUID@${CACHY}p2" ]
  # GRUB's own 30_os-prober (from the installed system) with a fake os-prober that finds CachyOS and a fake
  # linux-boot-prober that returns its kernel on the ESP: an entry without the skip list, none with it.
  fb=$W/fake-prober; mkdir -p "$fb"
  printf '#!/bin/sh\necho "%s:CachyOS:CachyOS:linux"\n' "${CACHY}p2" >"$fb/os-prober"
  printf '#!/bin/sh\necho "%s:%s:CachyOS:/vmlinuz-linux-cachyos:/initramfs-linux-cachyos.img:root=UUID=%s rw"\n' "${CACHY}p2" "${CACHY}p1" "$CACHY_UUID" >"$fb/linux-boot-prober"
  chmod +x "$fb/os-prober" "$fb/linux-boot-prober"
  osp() { env -i PATH="$fb:/usr/sbin:/usr/bin:/sbin:/bin" pkgdatadir=/usr/share/grub grub_probe=/usr/sbin/grub-probe GRUB_DISABLE_OS_PROBER=false "$@" sh "$m/etc/grub.d/30_os-prober" 2>"$W/osp.err"; }
  check "30_os-prober without the skip list: an os-prober entry for CachyOS (the test is meaningful)" bash -c 'grep -q "osprober-gnulinux" <<<"$1"' _ "$(osp || true)"
  out=$(osp GRUB_OS_PROBER_SKIP_LIST="$skip" || true)
  check "30_os-prober with the installed skip list: « Skipped CachyOS … by user request », no entry" bash -c '! grep -q "menuentry" <<<"$1" && grep -q "Skipped CachyOS on .* by user request" "$2"' _ "$out" "$W/osp.err"
  check "installed: grub-install wrapper (the ESP has EFI/BOOT)" test -x "$m/usr/local/sbin/grub-install"
  check "the install log names the chainload entry and the skip" bash -c 'grep -q "boot menu: « CachyOS » starts its own boot loader /EFI/limine/BOOTX64.EFI" "$1" && grep -q "os-prober skips partition 2" "$1"' _ "$W/install.log"
  umount "$m"
else
  # The completion marker, as a finished installation writes it (debugfs on our loop partition only).
  ours "${CACHY}p3"; printf 'AURORA_INSTALL_COMPLETE=2026-10-13T00:00:00Z\n' >"$W/install-info"
  debugfs -w -R "mkdir etc" "${CACHY}p3" >/dev/null 2>&1; debugfs -w -R "mkdir etc/aurora" "${CACHY}p3" >/dev/null 2>&1
  debugfs -w -R "write $W/install-info etc/aurora/install-info" "${CACHY}p3" >/dev/null 2>&1
fi
# 3) A finished installation is never offered again.
"$PROBE" --disk "$CACHY" --assume-uefi >"$W/probe-cachy3.json"
check "probe after a finished installation: no plan « reuse », p3 marked as an installed Selene OS" \
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1]))["disks"][0]; p3=[p for p in d["partitions"] if p["number"]==3][0]; print(d["alongside"]["reason"], [x["kind"] for x in d["alongside"]["plans"]]); sys.exit(0 if not any(x["kind"]=="reuse" for x in d["alongside"]["plans"]) and p3.get("seleneInstalled") and not p3.get("reuse") else 1)' "$W/probe-cachy3.json"
CACHY_FP=$(fp "$CACHY"); P3_UUID=$(blkid -p -s UUID -o value "${CACHY}p3")
rc=0; echo 'pw-test-123' | "$HELPER" "${cbase[@]}" --alongside --esp 1 --fingerprint "$CACHY_FP" --reuse-partition 3 --fail-at copy >"$W/out-cachy3.json" 2>>"$W/install.stderr" || rc=$?
check "--reuse-partition 3 on a finished installation: refused (exit 4), nothing written" [ "$rc:$(fp "$CACHY"):$(blkid -p -s UUID -o value "${CACHY}p3")" = "4:$CACHY_FP:$P3_UUID" ]

echo
echo "test-alongside: $PASS passed, $FAILS failed (log: $W/install.log)"
((FAILS == 0))
