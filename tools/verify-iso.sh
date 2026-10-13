#!/usr/bin/env bash
# Selene OS — static verification of a built ISO (no virtual machine is started).
#
#   sudo tools/verify-iso.sh [--iso PATH]     (default: newest out/selene-os-*.iso)
#
# Checks the boot structure (El Torito BIOS + UEFI images, GPT/MBR hybrid, EFI loader), the GRUB
# menu (syntax and kernel parameters), the casper live files and md5sum.txt, then mounts the
# squashfs read-only and checks its content: Electron + shell + runtime npm dependencies, session
# scripts and helpers, greetd, enabled services, firewall, permissions, locales, and that nothing
# from the build host leaked in (proxy, build CA, machine-id, SSH host keys). Prints PASS/WARN/FAIL
# lines and exits non-zero on any FAIL. Everything it mounts is unmounted on exit.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ISO=""
while (($#)); do
  case "$1" in
    --iso) ISO="${2:?--iso needs a path}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -E/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "verify-iso: unknown option $1" >&2; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "verify-iso: run as root (loop mounts): sudo $0" >&2; exit 1; }
for t in xorriso unsquashfs mount findmnt md5sum sha256sum mdir grub-script-check; do
  command -v "$t" >/dev/null 2>&1 || { echo "verify-iso: $t is required (xorriso squashfs-tools mtools grub-common)" >&2; exit 1; }
done
if [[ -z "$ISO" ]]; then
  ISO="$(find "$ROOT/out" -maxdepth 1 -name 'selene-os-*.iso' -printf '%T@ %p\n' 2>/dev/null | sort -rn | sed -n '1s/^[^ ]* //p')"
fi
[[ -n "$ISO" && -f "$ISO" ]] || { echo "verify-iso: no ISO found (make iso or --iso PATH)" >&2; exit 1; }
ISO="$(readlink -f "$ISO")"

FAILS=0; WARNS=0
pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; WARNS=$((WARNS + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # description command... -> PASS/FAIL
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$d"; else fail "$d"; fi
}

mkdir -p "$ROOT/work"
T="$(mktemp -d "$ROOT/work/verify.XXXXXX")"
cleanup() {
  local rc=$? mp
  while read -r mp; do umount "$mp" 2>/dev/null || umount -l "$mp" 2>/dev/null || true; done \
    < <(findmnt -rn -o TARGET | awk -v b="$T" 'index($0, b) == 1' | sort -r)
  if findmnt -rn -o TARGET | grep -qF "$T"; then echo "verify-iso: mounts left under $T" >&2; rc=1; else rm -rf "$T"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "== $ISO ($(stat -c %s "$ISO") bytes)"

# ---- checksum ------------------------------------------------------------------------------
if [[ -f "$ISO.sha256" ]]; then
  if (cd "$(dirname "$ISO")" && sha256sum --quiet -c "$(basename "$ISO").sha256"); then pass "sha256 matches $(basename "$ISO").sha256"
  else fail "sha256 does not match $(basename "$ISO").sha256"; fi
else
  warn "no $(basename "$ISO").sha256 next to the ISO"
fi

# ---- boot structure ------------------------------------------------------------------------
rep="$(xorriso -indev "$ISO" -report_el_torito plain -report_system_area plain 2>/dev/null)"
grep -Eq '^El Torito boot img : +1 +BIOS +y +none' <<<"$rep" && pass "El Torito: BIOS no-emulation boot image" || fail "El Torito: no BIOS boot image"
grep -q '^El Torito img path : *1 */boot/grub/i386-pc/eltorito.img' <<<"$rep" && pass "El Torito: BIOS image is GRUB (boot/grub/i386-pc/eltorito.img)" || fail "El Torito: BIOS image is not GRUB's eltorito.img"
grep -Eq '^El Torito boot img : +2 +UEFI +y +none' <<<"$rep" && pass "El Torito: UEFI boot image" || fail "El Torito: no UEFI boot image"
grep -Eq '^System area summary:.*grub2-mbr' <<<"$rep" && pass "system area: GRUB MBR boot code (BIOS boot from USB)" || fail "system area: no GRUB MBR code"
grep -Eq '^System area summary:.*GPT' <<<"$rep" && pass "system area: GPT (+ protective MBR)" || fail "system area: no GPT"
grep -Eq '^GPT type GUID +: +[0-9]+ +28732ac11ff8d211ba4b00a0c93ec93b' <<<"$rep" && pass "GPT: EFI System Partition present" || fail "GPT: no EFI System Partition"
if command -v sgdisk >/dev/null 2>&1; then
  sgdisk -p "$ISO" 2>/dev/null | grep -q 'EF00' && pass "sgdisk: EF00 partition in the GPT" || fail "sgdisk: no EF00 partition"
fi

mkdir -p "$T/iso" "$T/sq" "$T/efi"
# Loop-mount the ISO; kernels without iso9660 (some containers) get an extracted copy instead.
if ! mount -o loop,ro "$ISO" "$T/iso" 2>/dev/null; then
  echo "note: cannot mount iso9660 here, extracting the ISO with xorriso instead"
  xorriso -osirrox on -indev "$ISO" -extract / "$T/iso" >/dev/null 2>&1 || { fail "cannot read the ISO with xorriso"; exit 1; }
fi
I="$T/iso"
xorriso -osirrox on -indev "$ISO" -extract /efi.img "$T/efi.img" >/dev/null 2>&1 || true
if [[ -s "$T/efi.img" ]] && mdir -i "$T/efi.img" ::/EFI/BOOT 2>/dev/null | grep -qi 'BOOTX64 *EFI'; then
  pass "EFI image: /EFI/BOOT/BOOTX64.EFI ($(stat -c %s "$T/efi.img") bytes FAT image)"
else
  fail "EFI image: /EFI/BOOT/BOOTX64.EFI missing"
fi

# ---- ISO files -----------------------------------------------------------------------------
for f in casper/vmlinuz casper/initrd casper/filesystem.squashfs casper/filesystem.manifest \
         casper/filesystem.manifest-remove casper/filesystem.size .disk/info md5sum.txt \
         boot/grub/grub.cfg boot/grub/themes/aurora/theme.txt boot/grub/themes/aurora/background.png \
         boot/grub/themes/aurora/aurora-16.pf2 boot/grub/fonts/unicode.pf2; do
  [[ -s "$I/$f" ]] && pass "ISO has /$f" || fail "ISO lacks /$f"
done
[[ -d "$I/boot/grub/i386-pc" && -d "$I/boot/grub/x86_64-efi" ]] && pass "GRUB modules for i386-pc and x86_64-efi" || fail "GRUB module directories missing"
if (cd "$I" && md5sum --quiet -c md5sum.txt) >"$T/md5.log" 2>&1; then
  pass "md5sum.txt: all $(wc -l <"$I/md5sum.txt") files verified"
else
  fail "md5sum.txt mismatches: $(head -n3 "$T/md5.log" | tr '\n' ' ')"
fi

# ---- GRUB menu -----------------------------------------------------------------------------
cfg="$I/boot/grub/grub.cfg"
grub-script-check "$cfg" && pass "grub.cfg: grub-script-check OK" || fail "grub.cfg: syntax error"
entry() { awk -v id="--id $1" 'index($0, id) {f=1} f && /^ *linux / {print; exit}' "$cfg"; }
check_entry() { # id description required-words...
  local id="$1" d="$2" line w ok=1; shift 2
  line="$(entry "$id")"
  [[ -n "$line" ]] || { fail "grub.cfg: no entry $id ($d)"; return; }
  for w in boot=casper /casper/vmlinuz --- "$@"; do [[ " $line " == *" $w "* ]] || { ok=0; fail "grub.cfg: $id lacks '$w'"; }; done
  ((ok)) && pass "grub.cfg: $d — ${line#"${line%%[![:space:]]*}"}"
}
check_entry aurora-en "English entry" locale=en_US.UTF-8 keyboard-configuration/layoutcode=us quiet splash
check_entry aurora-fr "French entry" locale=fr_FR.UTF-8 keyboard-configuration/layoutcode=fr quiet splash
check_entry aurora-safe "safe graphics entry" nomodeset
check_entry aurora-debug "debug entry (serial console)" console=ttyS0,115200n8 aurora.debug
grep -q -- '--id hdd' "$cfg" && grep -q 'chainloader' "$cfg" && pass "grub.cfg: boot-from-disk entry (BIOS chainload / EFI loaders)" || fail "grub.cfg: no boot-from-disk entry"
grep -q 'set theme=' "$cfg" && pass "grub.cfg: Selene OS theme loaded when the fonts load" || fail "grub.cfg: no theme"
# GRUB decodes only 8-bit, non-interlaced RGB/RGBA PNGs (16-bit, palette or grey images show as garbage).
bad_png=""
for png in "$I"/boot/grub/themes/aurora/*.png; do
  [[ -f "$png" ]] || continue
  read -r depth ctype ilace < <(od -An -tu1 -j24 -N5 "$png" | awk '{print $1, $2, $5}')
  [[ "$depth" == 8 && ( "$ctype" == 2 || "$ctype" == 6 ) && "$ilace" == 0 ]] || bad_png+=" $(basename "$png")(depth=$depth,type=$ctype)"
done
[[ -z "$bad_png" ]] && pass "GRUB theme: every PNG is 8-bit RGB/RGBA (readable by GRUB)" || fail "GRUB theme: PNGs GRUB cannot decode:$bad_png"
# Every font named in theme.txt must be one of the theme's .pf2 fonts (GRUB falls back silently otherwise).
pf2_names="$(for f in "$I"/boot/grub/themes/aurora/*.pf2; do tr -c '[:print:]' '\n' <"$f" | grep -m1 -E '^[A-Za-z].* [0-9]+$'; done)"
missing_fonts=""
while IFS= read -r fname; do
  [[ -n "$fname" ]] && ! grep -qxF "$fname" <<<"$pf2_names" && missing_fonts+=" '$fname'"
done < <(grep -oE '(font|terminal-font|item_font|selected_item_font) *[=:] *"[^"]+"' "$I/boot/grub/themes/aurora/theme.txt" | sed -E 's/.*"([^"]+)"/\1/' | sort -u)
[[ -z "$missing_fonts" ]] && pass "GRUB theme: every font it names exists ($(wc -l <<<"$pf2_names") .pf2 fonts)" || fail "GRUB theme: fonts not found (GRUB would fall back to another font):$missing_fonts"
# Every image theme.txt names (desktop image, logo, 9-slice pixmaps) must be in the theme directory.
missing_img=""
while IFS= read -r img; do
  if [[ "$img" == *'*'* ]]; then compgen -G "$I/boot/grub/themes/aurora/$img" >/dev/null || missing_img+=" $img"
  else [[ -f "$I/boot/grub/themes/aurora/$img" ]] || missing_img+=" $img"; fi
done < <(grep -oE '(desktop-image|file|menu_pixmap_style|selected_item_pixmap_style|terminal-box) *[=:] *"[^"]+"' "$I/boot/grub/themes/aurora/theme.txt" | sed -E 's/.*"([^"]+)"/\1/' | sort -u)
[[ -z "$missing_img" ]] && pass "GRUB theme: every image it names exists" || fail "GRUB theme: images not found:$missing_img"
# Menu labels must fit the theme's menu box (640 px at item_font 20): keep them short.
long_lbl="$(grep -oE '^ *(menuentry|submenu) "[^"]+"' "$cfg" | sed -E 's/^ *(menuentry|submenu) "//; s/"$//' | awk 'length($0) > 40')"
[[ -z "$long_lbl" ]] && pass "grub.cfg: every menu label fits (40 characters max)" || fail "grub.cfg: labels too long for the menu: $(tr '\n' '|' <<<"$long_lbl")"
grep -q '^initrd /casper/initrd' <<<"$(sed 's/^ *//' "$cfg")" && pass "grub.cfg: initrd /casper/initrd" || fail "grub.cfg: no initrd line"

# ---- squashfs ------------------------------------------------------------------------------
sq="$I/casper/filesystem.squashfs"
sinfo="$(unsquashfs -s "$sq" 2>/dev/null)"
comp="$(sed -n 's/^Compression //p' <<<"$sinfo")"; bs="$(sed -n 's/^Block size //p' <<<"$sinfo")"
[[ -n "$comp" ]] && pass "squashfs: $(stat -c %s "$sq") bytes, compression $comp, block $bs, $(sed -n 's/^Number of inodes //p' <<<"$sinfo") inodes" || fail "squashfs: unreadable superblock"
mount -t squashfs -o loop,ro "$sq" "$T/sq"
S="$T/sq"
size_decl="$(cat "$I/casper/filesystem.size")"
pass "squashfs: filesystem.size declares $((size_decl / 1024 / 1024)) MiB"

must() { [[ -e "$S$1" || -L "$S$1" ]] && pass "image has $1" || fail "image lacks $1"; }
for f in /opt/aurora/electron/electron /opt/aurora/electron/chrome-sandbox /opt/aurora/electron/resources.pak \
         /opt/aurora/electron/locales/en-US.pak /opt/aurora/electron/locales/fr.pak \
         /opt/aurora/shell/package.json /opt/aurora/shell/main/index.js /opt/aurora/shell/preload/preload.js \
         /opt/aurora/shell/renderer/shell.html \
         /usr/bin/aurora-shell /usr/bin/aurora-session /usr/lib/aurora/aurora-greeter /usr/lib/aurora/aurora-xsession \
         /usr/lib/aurora/aurora-xstart /usr/lib/aurora/aurora-xgreeter /usr/lib/aurora/aurora-common \
         /etc/greetd/config.toml /etc/apparmor.d/aurora-shell /usr/lib/systemd/system/aurora-apparmor.service \
         /etc/polkit-1/rules.d/50-aurora.rules /etc/sudoers.d/aurora /etc/casper.conf /etc/aurora/build-id \
         /etc/skel/Desktop/Welcome.txt /etc/skel/.config/user-dirs.dirs /boot/vmlinuz /var/lib/aurora-greeter; do
  must "$f"
done
# Boot hand-over: 'plymouth quit --retain-splash' leaves tty1 in graphics mode, and the kernel then ignores every
# VT switch, so greetd waits forever for its VT (greetd.toml 'vt') and the screen stays on the splash / black.
gvt="$(sed -nE 's/^ *vt *= *([0-9]+).*/\1/p' "$S/etc/greetd/config.toml" | head -1)"
if grep -rqs -- '--retain-splash' "$S"/etc/systemd/system/plymouth-quit*.service.d "$S"/usr/lib/systemd/system/plymouth-quit*.service \
   && [[ "$gvt" != 1 ]]; then
  fail "plymouth quits with --retain-splash but greetd runs on vt $gvt: the VT switch is refused (black screen after the splash)"
else
  pass "boot hand-over: Plymouth leaves the console in text mode, so greetd can switch to vt ${gvt:-?}"
fi
for d in Desktop Documents Downloads Pictures Music Videos; do [[ -d "$S/etc/skel/$d" ]] || fail "skel lacks $d"; done
pass "skel folders: Desktop Documents Downloads Pictures Music Videos"
if [[ -f "$S/opt/aurora/shell/renderer/greeter.html" ]]; then pass "image has /opt/aurora/shell/renderer/greeter.html"
else warn "image lacks /opt/aurora/shell/renderer/greeter.html (sign-in screen not built yet)"; fi
# Runtime npm dependencies declared by the shell.
deps="$(python3 -I -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1])).get("dependencies", {})))' "$S/opt/aurora/shell/package.json")"
missing=""; for d in $deps; do [[ -f "$S/opt/aurora/shell/node_modules/$d/package.json" ]] || missing+=" $d"; done
[[ -z "$missing" ]] && pass "npm runtime dependencies present: $deps" || fail "npm dependencies missing:$missing"
[[ ! -e "$S/opt/aurora/shell/node_modules/electron" && ! -e "$S/opt/aurora/shell/node_modules/playwright-core" ]] \
  && pass "no npm devDependencies (electron, playwright-core) in the image" || fail "devDependencies shipped in /opt/aurora/shell/node_modules"
helpers="$(find "$S/usr/lib/aurora/helpers" -maxdepth 1 -type f 2>/dev/null | sed "s|^$S||" | sort | tr '\n' ' ' || true)"
if [[ -n "$helpers" ]]; then
  nonexec="$(find "$S/usr/lib/aurora/helpers" -maxdepth 1 -type f ! -perm -0755 2>/dev/null | sed "s|^$S||" || true)"
  [[ -z "$nonexec" ]] && pass "helpers (0755 root): $helpers" || fail "helpers not 0755: $nonexec"
else
  warn "no helpers in /usr/lib/aurora/helpers yet"
fi
# Linux GUI applications (docs/XWINDOWS.md): the window manager helper and its Python X library.
if [[ -x "$S/usr/lib/aurora/helpers/aurora-xwm" ]]; then
  pass "image has the aurora-xwm window manager helper"
  if compgen -G "$S/usr/lib/python3/dist-packages/Xlib/display.py" >/dev/null; then pass "python3-xlib is installed (aurora-xwm)"
  else fail "python3-xlib is missing: Linux applications cannot be shown (rebuild with --from packages)"; fi
else
  fail "image lacks /usr/lib/aurora/helpers/aurora-xwm (Linux applications)"
fi
# Store sources (docs/STORE-SOURCES.md): Flatpak for Flathub, AppStream metadata for the Ubuntu catalogue.
for b in /usr/bin/flatpak /usr/libexec/xdg-desktop-portal /usr/libexec/xdg-desktop-portal-gtk /usr/bin/appstreamcli /usr/bin/gsettings; do
  [[ -x "$S$b" ]] && pass "image has $b (Store sources)" || fail "image lacks $b (Store sources: rebuild with --from packages)"
done
[[ -f "$S/etc/apt/apt.conf.d/50appstream" ]] && pass "apt downloads AppStream metadata (50appstream)" || fail "apt.conf.d/50appstream missing: the Store cannot verify Ubuntu catalogue packages"
[[ -s "$S/usr/share/aurora/store/base-packages.txt" ]] && pass "Store base package list present (image packages are never removed from the Store)" || fail "usr/share/aurora/store/base-packages.txt missing"
compgen -G "$S/usr/lib/python3/dist-packages/yaml/__init__.py" >/dev/null && pass "python3-yaml is installed (Ubuntu catalogue)" || fail "python3-yaml is missing (Ubuntu catalogue)"
# Graphics drivers (iso/packages.d/drivers.list): the installer's « Pilote graphique » step and Settings > Graphics
# drivers download the NVIDIA driver from the archive; the image only carries the tools.
for b in /usr/bin/ubuntu-drivers /usr/bin/mokutil /usr/bin/lspci; do
  [[ -x "$S$b" ]] && pass "image has $b (graphics drivers)" || fail "image lacks $b (graphics drivers: rebuild with --from packages)"
done
[[ -s "$S/usr/share/misc/pci.ids" || -s "$S/usr/share/hwdata/pci.ids" ]] && pass "pci.ids present (graphics card names)" || warn "no pci.ids: graphics cards are shown by their PCI ids"
# the proprietary / open driver modules (nvidia.ko, nvidia-drm, -modeset, -uvm, -peermem); the stock kernel's
# nvidia-wmi-ec-backlight (laptop backlight control) is not a graphics driver
nvd="$(find "$S/usr/lib/modules" \( -name 'nvidia.ko*' -o -name 'nvidia-drm.ko*' -o -name 'nvidia-modeset.ko*' -o -name 'nvidia-uvm.ko*' -o -name 'nvidia-peermem.ko*' \) 2>/dev/null | head -n1 || true)"
[[ -z "$nvd" ]] && ! compgen -G "$S/usr/lib/x86_64-linux-gnu/libnvidia-glcore.so*" >/dev/null \
  && pass "no NVIDIA driver bundled in the image (downloaded during the installation)" || warn "an NVIDIA driver is bundled in the image: $nvd"
grep -qs 'Driver' "$S"/etc/X11/xorg.conf.d/*.conf && fail "an /etc/X11/xorg.conf.d file forces an Xorg driver (the NVIDIA driver must stay possible)" \
  || pass "no Xorg driver forced in /etc/X11/xorg.conf.d (noaccel.conf is only used without a GPU / nvidia)"
# Games (iso/packages.d/gaming.list): GameMode is always in the image; the gaming apps come from Flathub at the
# first sign-in (installer « Jeux » step), never from the image.
# Ubuntu's gamemode ships gamemoderun in /usr/games (gamemoded comes with gamemode-daemon): both dirs are accepted.
for b in gamemoderun gamemoded; do
  if [[ -x "$S/usr/games/$b" || -x "$S/usr/bin/$b" ]]; then pass "image has $b (GameMode)"
  else fail "image lacks $b in /usr/games or /usr/bin (GameMode: rebuild with --from packages)"; fi
done
compgen -G "$S/usr/lib/*-linux-gnu/libgamemode.so*" >/dev/null && pass "libgamemode is installed (GameMode)" || fail "libgamemode is missing (GameMode)"
# Printing (iso/packages.d/printing.list): CUPS clients and daemon, driverless (IPP Everywhere) support, discovery,
# the units enabled at boot (iso/build.sh configure_services) and the aurora-admin printer-* actions.
for b in /usr/sbin/cupsd /usr/bin/lp /usr/bin/lpstat /usr/sbin/lpadmin /usr/sbin/lpinfo /usr/bin/cancel /usr/sbin/cupsenable \
         /usr/sbin/cupsdisable /usr/sbin/cupsaccept /usr/bin/ipptool /usr/sbin/ipp-usb /usr/sbin/avahi-daemon /usr/bin/avahi-browse; do
  [[ -x "$S$b" ]] && pass "image has $b (printing)" || fail "image lacks $b (printing: rebuild with --from packages)"
done
[[ -f "$S/usr/share/cups/data/default-testpage.pdf" || -f "$S/usr/share/cups/data/testprint" ]] && pass "CUPS test page (default-testpage.pdf, libcupsfilters2-common)" || fail "no /usr/share/cups/data/default-testpage.pdf (« Imprimer une page de test »)"
[[ -x "$S/usr/lib/cups/filter/pdftopdf" ]] && pass "cups-filters: pdftopdf filter (driverless printing)" || fail "cups-filters: no pdftopdf filter"
compgen -G "$S/usr/lib/*-linux-gnu/libnss_mdns4_minimal.so*" >/dev/null && grep -q 'mdns4_minimal' "$S/etc/nsswitch.conf" \
  && pass "libnss-mdns: *.local names resolve (nsswitch.conf)" || fail "libnss-mdns missing or not in /etc/nsswitch.conf"
for u in cups.socket cups.path cups.service avahi-daemon.service; do
  st="$(systemctl --root="$S" is-enabled "$u" 2>/dev/null || true)"
  [[ "$st" == enabled ]] && pass "systemctl --root: $u is $st (printing)" || fail "systemctl --root: $u is '$st' (printing)"
done
grep -q "^printer-add | printer-remove | printer-default | printer-enable | printer-rename | printer-job-cancel)" "$S/usr/lib/aurora/helpers/aurora-admin" \
  && pass "aurora-admin has the printer-* actions" || fail "aurora-admin lacks the printer-* actions"
grep -q -- '--gaming' "$S/usr/lib/aurora/helpers/aurora-install" 2>/dev/null && pass "the installer helper records the gaming apps (--gaming)" || fail "aurora-install has no --gaming (installer « Jeux » step)"
# Print dialog (iso/packages.d/printdialog.list, shell core/print.js + main/ipc/print.js): page ranges of a PDF are cut
# with qpdf (pdfseparate + pdfunite as a fallback), the pdf.js preview ships with the shell.
for b in /usr/bin/qpdf /usr/bin/pdfseparate /usr/bin/pdfunite; do
  [[ -x "$S$b" ]] && pass "image has $b (print dialog)" || fail "image lacks $b (print dialog: rebuild with --from packages)"
done
for f in /opt/aurora/shell/main/ipc/print.js /opt/aurora/shell/renderer/core/print.js /opt/aurora/shell/renderer/core/print.css \
         /opt/aurora/shell/renderer/core/print-ranges.js /opt/aurora/shell/node_modules/pdfjs-dist/build/pdf.mjs; do
  [[ -f "$S$f" ]] && pass "image has $f (print dialog)" || fail "image lacks $f (print dialog)"
done
# Screen reader (iso/packages.d/screen-reader.list): Orca + speech-dispatcher (espeak-ng, French voice) + AT-SPI.
for b in /usr/bin/orca /usr/bin/spd-say /usr/bin/espeak-ng /usr/libexec/at-spi-bus-launcher /usr/bin/gsettings; do
  [[ -x "$S$b" ]] && pass "image has $b (screen reader)" || fail "image lacks $b (screen reader: rebuild with --from packages)"
done
compgen -G "$S/usr/lib/speech-dispatcher-modules/sd_espeak-ng" >/dev/null || compgen -G "$S/usr/lib/*-linux-gnu/speech-dispatcher-modules/sd_espeak-ng" >/dev/null \
  && pass "speech-dispatcher has its espeak-ng module" || fail "speech-dispatcher's espeak-ng module is missing (speech-dispatcher-espeak-ng)"
compgen -G "$S/usr/lib/*-linux-gnu/espeak-ng-data/fr_dict" >/dev/null && compgen -G "$S/usr/lib/*-linux-gnu/espeak-ng-data/lang/roa/fr" >/dev/null \
  && pass "espeak-ng has the French voice" || fail "espeak-ng's French voice data is missing (espeak-ng-data)"
[[ -d "$S/usr/lib/python3/dist-packages/speechd" ]] && pass "Orca can reach speech-dispatcher (python3-speechd)" || fail "python3-speechd is missing (Orca would stay silent)"
[[ -f "$S/usr/share/glib-2.0/schemas/org.gnome.desktop.a11y.applications.gschema.xml" ]] && pass "a11y gsettings schema present (screen-reader-enabled)" || fail "org.gnome.desktop.a11y.applications schema missing"
[[ -L "$S/etc/systemd/user/sockets.target.wants/speech-dispatcher.socket" ]] && pass "speech-dispatcher user socket enabled" || warn "speech-dispatcher.socket not enabled for users (clients still autospawn it)"
[[ ! -e "$S/etc/systemd/system/multi-user.target.wants/speech-dispatcherd.service" ]] && pass "no system-wide speech-dispatcherd" || fail "system-wide speech-dispatcherd.service is enabled (it must run per user)"
grep -qs 'force-renderer-accessibility' "$S/opt/aurora/shell/main/ipc/screenreader.js" && pass "the shell turns Chromium accessibility on for the screen reader" || warn "shell screenreader backend not found in /opt/aurora/shell"
bad="$(find "$S/usr/bin" "$S/usr/lib/aurora" -maxdepth 1 -name 'aurora-*' -type f ! -perm -0755 ! -name aurora-common | sed "s|^$S||")"
[[ -z "$bad" ]] && pass "session entry points are executable" || fail "not executable: $bad"

# Permissions.
[[ "$(stat -c '%U:%G %a' "$S/opt/aurora/electron/chrome-sandbox")" == "root:root 4755" ]] && pass "chrome-sandbox is root:root 4755" || fail "chrome-sandbox is $(stat -c '%U:%G %a' "$S/opt/aurora/electron/chrome-sandbox")"
ww="$(find "$S/opt/aurora" \( -type f -o -type d \) -perm -0002 | head -n5)"
[[ -z "$ww" ]] && pass "no world-writable files under /opt/aurora" || fail "world-writable under /opt/aurora: $ww"
nr="$(find "$S/opt/aurora" ! -user 0 | head -n5)"
[[ -z "$nr" ]] && pass "/opt/aurora is owned by root" || fail "not root-owned under /opt/aurora: $nr"
[[ "$(stat -c %a "$S/etc/sudoers.d/aurora")" == 440 ]] && pass "/etc/sudoers.d/aurora is 0440" || fail "/etc/sudoers.d/aurora mode $(stat -c %a "$S/etc/sudoers.d/aurora")"
# setuid/setgid: only the expected binaries (Ubuntu's account/mount/privilege tools, Chromium's
# sandbox helper; mount.cifs belongs to casper's dependencies and is purged by the installer).
SUID_OK=" /opt/aurora/electron/chrome-sandbox /usr/bin/chage /usr/bin/chfn /usr/bin/chsh /usr/bin/expiry
  /usr/bin/fusermount3 /usr/bin/gpasswd /usr/bin/mount /usr/bin/newgrp /usr/bin/passwd /usr/bin/pkexec /usr/bin/su
  /usr/bin/sudo /usr/bin/umount /usr/lib/dbus-1.0/dbus-daemon-launch-helper /usr/lib/polkit-1/polkit-agent-helper-1
  /usr/sbin/mount.cifs /usr/sbin/pam_extrausers_chkpwd /usr/sbin/unix_chkpwd /usr/bin/ssh-agent /usr/bin/crontab "
SUID_OK="$(tr -s ' \n' ' ' <<<"$SUID_OK")"
suid="$(find "$S" -xdev -type f -perm /6000 -printf '/%P\n' | sort | tr '\n' ' ')"
unexpected=""; for f in $suid; do [[ "$SUID_OK" == *" $f "* ]] || unexpected+=" $f"; done
[[ -z "$unexpected" ]] && pass "setuid/setgid files are all expected: $suid" || fail "unexpected setuid/setgid files:$unexpected"
# sudo: no passwordless rule is shipped (the live user's NOPASSWD rule is written by casper at boot).
sd="$(find "$S/etc/sudoers.d" -mindepth 1 -printf '%f ' | sort)"
nopw="$(grep -rhs 'NOPASSWD' "$S/etc/sudoers" "$S/etc/sudoers.d" | grep -v '^[[:space:]]*#' || true)"
if [[ -n "$nopw" ]]; then fail "a NOPASSWD sudo rule is shipped in the image: $nopw"
else pass "no NOPASSWD sudo rule in the image (/etc/sudoers.d: $sd)"; fi
[[ ! -e "$S/etc/sudoers.d/casper" ]] && pass "/etc/sudoers.d/casper is not in the image (casper writes it in the live session only)" || fail "/etc/sudoers.d/casper shipped"
# polkit: the Selene OS rule grants nothing to non-administrators beyond power actions.
pr="$S/etc/polkit-1/rules.d/50-aurora.rules"
if grep -q 'isInGroup("netdev")' "$pr"; then warn "50-aurora.rules grants actions to the netdev group (standard users)"
else pass "polkit 50-aurora.rules: network/drive grants limited to administrators (group sudo)"; fi
# Automated install: gated to the live medium.
au="$S/usr/lib/systemd/system/aurora-autoinstall.service"
if [[ -f "$au" ]]; then
  grep -qx 'ConditionKernelCommandLine=aurora.autoinstall=1' "$au" && grep -qx 'ConditionKernelCommandLine=boot=casper' "$au" \
    && grep -qx 'ConditionPathIsDirectory=/cdrom/casper' "$au" \
    && pass "aurora-autoinstall.service only runs with aurora.autoinstall=1 + boot=casper + /cdrom/casper" \
    || fail "aurora-autoinstall.service is not gated to the live medium"
fi
[[ "$(stat -c '%U %a' "$S/var/lib/aurora-greeter")" == "_greetd 750" || "$(stat -c '%u %a' "$S/var/lib/aurora-greeter")" =~ ^[0-9]+\ 750$ ]] \
  && pass "/var/lib/aurora-greeter: $(stat -c '%u:%g %a' "$S/var/lib/aurora-greeter")" || fail "/var/lib/aurora-greeter has wrong mode"
grep -qx 'd /var/lib/aurora/faces 1733 root root -' "$S/usr/lib/tmpfiles.d/aurora.conf" \
  && pass "tmpfiles.d: /var/lib/aurora/faces 1733 (account pictures for the sign-in screen)" || fail "tmpfiles.d: /var/lib/aurora/faces entry missing"

# Configuration.
gc="$S/etc/greetd/config.toml"
grep -q '^command = "/usr/lib/aurora/aurora-greeter"' "$gc" && grep -q '^user = "_greetd"' "$gc" \
  && pass "greetd: default_session = aurora-greeter as _greetd" || fail "greetd default_session wrong"
awk '/^\[initial_session\]/ {f=1; next} /^\[/ {f=0} f' "$gc" | tr '\n' ' ' | grep -q 'command = "/usr/bin/aurora-session" user = "aurora"' \
  && pass "greetd: initial_session autologin of the live user 'aurora' into aurora-session" || fail "greetd initial_session wrong"
grep -q '^_greetd:.*:/var/lib/aurora-greeter:' "$S/etc/passwd" && pass "_greetd home is /var/lib/aurora-greeter" || fail "_greetd home is not /var/lib/aurora-greeter"
grep -q 'export USERNAME="aurora"' "$S/etc/casper.conf" && pass "casper.conf: live user aurora, host $(sed -n 's/^export HOST="\(.*\)"/\1/p' "$S/etc/casper.conf")" || fail "casper.conf wrong"
grep -q '^ENABLED=yes' "$S/etc/ufw/ufw.conf" && pass "ufw: ENABLED=yes" || fail "ufw not enabled"
grep -q '^DEFAULT_INPUT_POLICY="DROP"' "$S/etc/default/ufw" && pass "ufw: incoming DROP by default" || fail "ufw default input policy"
pn="$(sed -n 's/^PRETTY_NAME=//p' "$S/usr/lib/os-release")"
[[ "$pn" == '"Selene OS '* ]] && pass "os-release PRETTY_NAME=$pn, $(grep -E '^(ID|ID_LIKE|VERSION_CODENAME)=' "$S/usr/lib/os-release" | tr '\n' ' ')" || fail "os-release PRETTY_NAME=$pn"
pass "build id: $(cat "$S/etc/aurora/build-id")"
for u in greetd NetworkManager systemd-resolved ufw apparmor aurora-apparmor; do
  st="$(systemctl --root="$S" is-enabled "$u.service" 2>/dev/null || true)"
  [[ "$st" == enabled ]] && pass "systemctl --root: $u.service is $st" || fail "systemctl --root: $u.service is '$st'"
done
st="$(systemctl --root="$S" is-enabled systemd-networkd-wait-online.service 2>/dev/null || true)"
[[ "$st" == masked ]] && pass "systemd-networkd-wait-online.service is masked" || warn "systemd-networkd-wait-online.service is '$st'"
dt="$(readlink "$S/etc/systemd/system/default.target")"
[[ "$dt" == */graphical.target ]] && pass "default target: graphical.target" || fail "default target: $dt"
[[ "$(readlink "$S/etc/systemd/system/display-manager.service")" == */greetd.service ]] && pass "display-manager.service -> greetd.service" || fail "display-manager.service is not greetd"
la="$(LC_ALL=C localedef --list-archive "$S/usr/lib/locale/locale-archive" 2>/dev/null | tr '\n' ' ' || true)"
[[ "$la" == *en_US.utf8* && "$la" == *fr_FR.utf8* ]] && pass "locales compiled: $la" || fail "locales: '$la'"
grep -q '^LANG=en_US.UTF-8' "$S/etc/default/locale" && pass "default locale en_US.UTF-8" || fail "default locale: $(cat "$S/etc/default/locale")"

# Bluetooth (iso/packages.d/bluetooth.list): BlueZ + PipeWire plugin + the session helper, bluetoothd at boot,
# and the D-Bus policy that lets the signed-in user pair without root.
for p in bluez libspa-0.2-bluetooth python3-dbus python3-gi rfkill; do
  grep -A1 -x "Package: $p" "$S/var/lib/dpkg/status" | grep -q '^Status: install ok installed' && pass "package $p installed" || fail "package $p missing"
done
st="$(systemctl --root="$S" is-enabled bluetooth.service 2>/dev/null || true)"
[[ "$st" == enabled ]] && pass "systemctl --root: bluetooth.service is $st" || fail "systemctl --root: bluetooth.service is '$st'"
[[ -x "$S/usr/lib/aurora/helpers/aurora-bluetooth" ]] && pass "aurora-bluetooth helper is executable" || fail "aurora-bluetooth helper missing"
compgen -G "$S/usr/lib/x86_64-linux-gnu/spa-0.2/bluez5/libspa-bluez5*.so" >/dev/null && pass "PipeWire bluez5 SPA plugin present" || fail "PipeWire bluez5 SPA plugin missing"
btconf="$(cat "$S/usr/share/dbus-1/system.d/bluetooth.conf" "$S/etc/dbus-1/system.d/bluetooth.conf" 2>/dev/null || true)"
tr -d '\n' <<<"$btconf" | grep -Eq '<policy context="default">[[:space:]]*<allow send_destination="org.bluez"/>' \
  && pass "bluez D-Bus policy: any local user may talk to org.bluez" || fail "bluez D-Bus policy does not allow the session user"
grep -qs 'KERNEL=="rfkill".*uaccess' "$S/usr/lib/udev/rules.d/70-uaccess.rules" && pass "/dev/rfkill is uaccess (session user can unblock Bluetooth)" || warn "/dev/rfkill is not tagged uaccess"

# Firmware updates (iso/packages.d/firmware-updates.list): fwupd + its D-Bus activation for the session, the daily
# metadata refresh timer (iso/build.sh configure_services), the signed UEFI capsule loader, aurora-admin firmware-update.
for p in fwupd fwupd-signed; do
  grep -A1 -x "Package: $p" "$S/var/lib/dpkg/status" | grep -q '^Status: install ok installed' && pass "package $p installed (firmware updates)" || fail "package $p missing (firmware updates)"
done
for b in /usr/bin/fwupdmgr /usr/libexec/fwupd/fwupd; do
  [[ -x "$S$b" ]] && pass "image has $b (firmware updates)" || fail "image lacks $b (firmware updates: rebuild with --from packages)"
done
[[ -f "$S/usr/share/dbus-1/system-services/org.freedesktop.fwupd.service" ]] && pass "fwupd is D-Bus activated (org.freedesktop.fwupd)" || fail "no D-Bus activation file for fwupd"
compgen -G "$S/usr/libexec/fwupd/efi/fwupd*.efi.signed" >/dev/null && pass "signed fwupd EFI binary present (UEFI capsules with Secure Boot)" || warn "no signed fwupd EFI binary: UEFI capsule updates need Secure Boot off"
st="$(systemctl --root="$S" is-enabled fwupd-refresh.timer 2>/dev/null || true)"
[[ "$st" == enabled ]] && pass "systemctl --root: fwupd-refresh.timer is $st" || fail "systemctl --root: fwupd-refresh.timer is '$st'"
grep -q '^firmware-update)' "$S/usr/lib/aurora/helpers/aurora-admin" && pass "aurora-admin has the firmware-update action" || fail "aurora-admin lacks firmware-update"

# Build leftovers / host leaks.
[[ ! -s "$S/etc/machine-id" ]] && pass "/etc/machine-id is empty (generated at boot)" || fail "/etc/machine-id is set"
compgen -G "$S/etc/ssh/ssh_host_*" >/dev/null && fail "SSH host keys shipped" || pass "no SSH host keys"
[[ ! -e "$S/etc/apt/aurora-build-ca.crt" && ! -e "$S/etc/apt/apt.conf.d/99aurora-build" ]] && pass "no build-time apt CA/proxy configuration" || fail "build-time apt configuration shipped"
grep -rqis 'proxy' "$S/etc/environment" "$S/etc/apt/apt.conf.d" 2>/dev/null && fail "proxy settings in /etc/environment or apt.conf.d" || pass "no proxy in /etc/environment or apt.conf.d"
for p in ${https_proxy:-} ${HTTPS_PROXY:-} ${http_proxy:-}; do
  if grep -rIlsF -- "$p" "$S/etc" "$S/root" "$S/opt/aurora" "$S/home" "$S/var/lib/apt" >/dev/null 2>&1; then fail "host proxy $p found in the image"
  else pass "host proxy $p not referenced in /etc /root /opt/aurora /home /var/lib/apt"; fi
done
for ca in /root/.ccr/ca-bundle.crt ${BUILD_CA_BUNDLE:-}; do
  [[ -f "$ca" ]] || continue
  sum="$(sha256sum <"$ca" | cut -d' ' -f1)"
  hit="$(find "$S/etc" "$S/usr/local" "$S/usr/share/ca-certificates" "$S/opt" -type f -size "$(stat -Lc %s "$ca")c" -exec sha256sum {} + 2>/dev/null | awk -v s="$sum" '$1 == s {print $2}' || true)"
  [[ -z "$hit" ]] && pass "build CA bundle $ca not shipped" || fail "build CA bundle shipped: $hit"
done
grep -q 'URIs: http://archive.ubuntu.com/ubuntu' "$S/etc/apt/sources.list.d/ubuntu.sources" && pass "apt sources: archive.ubuntu.com + security.ubuntu.com" || fail "apt sources not final"
[[ -L "$S/etc/resolv.conf" ]] && pass "/etc/resolv.conf -> $(readlink "$S/etc/resolv.conf")" || warn "/etc/resolv.conf is not a symlink"

# No build-time helpers left behind.
[[ ! -e "$S/usr/sbin/policy-rc.d" ]] && pass "no /usr/sbin/policy-rc.d" || fail "/usr/sbin/policy-rc.d shipped (services would never start)"
[[ ! -e "$S/etc/resolv.conf.aurora-build" ]] && pass "no build-time resolv.conf" || fail "build-time resolv.conf shipped"
leftover="$(find "$S/var/log" -type f -size +0 -printf '/var/log/%P ' 2>/dev/null; find "$S/tmp" "$S/var/tmp" "$S/root" -mindepth 1 \( -name '.bash_history' -o -name '.npm' -o -name '.cache' -o -type f -path '*/tmp/*' \) -printf '/%P ' 2>/dev/null)"
[[ -z "$leftover" ]] && pass "logs and temporary files are empty" || fail "build leftovers: $leftover"
nlists="$(find "$S/var/lib/apt/lists" -type f ! -name lock 2>/dev/null | wc -l)"; ndebs="$(find "$S/var/cache/apt/archives" -name '*.deb' 2>/dev/null | wc -l)"
((nlists == 0 && ndebs == 0)) && pass "apt lists and .deb cache are empty" || fail "apt caches not cleaned ($nlists list files, $ndebs debs)"

# initramfs: casper + Selene OS splash.
if [[ -x "$S/usr/bin/lsinitramfs" ]]; then
  mount -t tmpfs tmpfs "$S/tmp" && mount -t tmpfs tmpfs "$S/var/tmp" && mount -t proc proc "$S/proc" && mount --bind /dev "$S/dev"
  cp "$I/casper/initrd" "$S/tmp/initrd"
  lst="$(chroot "$S" lsinitramfs /tmp/initrd 2>/dev/null || true)"
  grep -q 'scripts/casper-bottom/25adduser' <<<"$lst" && pass "initrd: casper scripts" || fail "initrd: no casper scripts"
  grep -q 'usr/share/plymouth/themes/aurora/aurora.plymouth' <<<"$lst" && pass "initrd: Selene OS Plymouth theme" || warn "initrd: no Selene OS Plymouth theme"
  grep -Eq 'virtio-gpu\.ko|virtio_gpu' <<<"$lst" && pass "initrd: virtio-gpu driver" || warn "initrd: no virtio-gpu module"
  if out="$(chroot "$S" apparmor_parser --skip-kernel-load --skip-cache -Q /etc/apparmor.d/aurora-shell 2>&1)"; then
    pass "AppArmor profile /etc/apparmor.d/aurora-shell parses (apparmor_parser -Q in the image)"
  else
    fail "AppArmor profile does not parse: $out"
  fi
  umount "$S/dev" "$S/proc" "$S/var/tmp" "$S/tmp"
fi

echo "== $FAILS failure(s), $WARNS warning(s)"
((FAILS == 0))
