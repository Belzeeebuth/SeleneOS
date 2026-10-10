# Building and running Aurora OS

*Version française : [plus bas](#version-française).*

Aurora OS is shipped as one hybrid ISO image (`out/aurora-os-<version>-amd64.iso`) that boots
on BIOS and UEFI machines, from a DVD or a USB stick, and in virtual machines. It starts a live
session (nothing is written to the disk) from which Aurora OS can be installed.

- [Prerequisites](#prerequisites)
- [Build the ISO](#build-the-iso) — **`make iso`**
- [Build in Docker](#build-in-docker)
- [Build settings](#build-settings)
- [Measured build time and size](#measured-build-time-and-size)
- [Check the image without a VM](#check-the-image-without-a-vm)
- [Try it in QEMU](#try-it-in-qemu) (live session, installation, BIOS and UEFI)
- [What to expect](#what-to-expect)
- [Install Aurora OS](#install-aurora-os) (graphical installer, testing it without a VM)
- [Automated install](#automated-install) (`aurora.autoinstall=1`)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- An **Ubuntu 24.04** (or Debian 12+/Ubuntu 22.04+) x86-64 host with **root** access (`sudo`).
  The build uses `debootstrap`, `chroot` and overlay mounts.
- About **25 GB free** in the repository's file system (the build itself uses ~2.7 GB in `work/`,
  ~0.7 GB of downloads in `cache/` and ~0.75 GB for the ISO; the rest is headroom for the
  package layer growing), 4 GB RAM or more.
- Network access to `snapshot.ubuntu.com` (HTTPS) and `github.com` (Electron download).
  Behind a proxy, export `https_proxy`/`http_proxy`; for a TLS-intercepting proxy, also set
  `BUILD_CA_BUNDLE=/path/to/ca.pem`. Proxy settings and CA are used during the build only and are
  never copied into the image (the build checks this).
- Build tools:

  ```sh
  sudo apt-get install debootstrap ubuntu-keyring squashfs-tools xorriso mtools dosfstools \
       grub-common grub-pc-bin grub-efi-amd64-bin librsvg2-bin imagemagick unzip curl zstd git
  ```

  and **Node.js 22** (for `npm ci` of the shell's runtime dependencies). The build looks for it in
  `/opt/node22/bin` (override with `NODE_BIN=...`) and then in `PATH`.

No other host setup is needed: Electron is downloaded and verified by the build. Without an
Ubuntu/Debian host, use [Docker](#build-in-docker).

## Build the ISO

From the `aurora-os/` directory:

```sh
make iso
```

That is the whole build (it runs `sudo ./iso/build.sh`). Results, in `out/`:

| File | Content |
|---|---|
| `aurora-os-1.0.0-amd64.iso` | the bootable, installable hybrid ISO (BIOS + UEFI, DVD + USB) |
| `aurora-os-1.0.0-amd64.iso.sha256` | its SHA-256 (`sha256sum -c` in `out/`) |
| `aurora-os-1.0.0-amd64.manifest` | every Debian package in the image, with its version |

The output files are handed back to the user who ran `sudo`/`make`. The complete build log is
in `work/logs/latest.log`.

How the build works (`iso/build.sh`, configuration in `iso/config.sh`):

| Stage | What it does | Cached in |
|---|---|---|
| `base` | `debootstrap --variant=minbase noble` from the pinned snapshot | `cache/base/*.tar.zst` |
| `packages` | apt installs every `iso/packages.d/*.list` (plus the kernel), unknown package names stop the build with a clear report | `work/layers/packages`, `.deb`s in `cache/apt` |
| `system` | overlay on top: Electron (SHA-256 checked, `chrome-sandbox` setuid, AppArmor profile), Aurora Shell in `/opt/aurora/shell` (`npm ci --omit=dev`), `rootfs/` overlay, locales en_US/fr_FR, live user, greetd, services, firewall, Plymouth splash, initramfs, image validation | rebuilt each time (~1 min) |
| `squashfs` | package manifests + `casper/filesystem.squashfs` (zstd) | |
| `iso` | themed GRUB menu, hybrid BIOS+UEFI ISO (`grub-mkrescue`/xorriso), checksum | |

Rebuilds are incremental: the base system and the package layer are reused while their inputs
do not change; packages added to a `.list` are installed into the existing layer; a removed
package rebuilds the layer. Useful options (`make iso BUILD_ARGS="..."`):

```sh
sudo ./iso/build.sh --until system     # stop after a stage: base|packages|system|squashfs|iso
sudo ./iso/build.sh --from squashfs    # redo only the last stages
sudo ./iso/build.sh --rebuild-packages # reinstall all packages
sudo ./iso/build.sh --clean            # start from scratch (keeps the download cache)
```

`make clean` removes `work/` except the VM disk (`work/qemu/`), `make clean-vm` removes the VM
disk, `make distclean` removes `work/`, `cache/` and `out/`. Every mount made by the build is
undone when it ends, even after an error or Ctrl+C.

### Reproducibility

- Packages come from a dated snapshot of the Ubuntu archive
  (`https://snapshot.ubuntu.com/ubuntu/<STAMP>`), so the same commit gives the same package set.
- Electron's version comes from `shell/package.json`; the zip is checked against the release's
  `SHASUMS256.txt` **and** the checksum pinned in `iso/config.sh`.
- npm dependencies come from `shell/package-lock.json` (`npm ci`).
- File times inside the image are clamped to `SOURCE_DATE_EPOCH` (the last git commit).
- `/etc/aurora/build-id` and `/etc/aurora/build-info` in the image record the version, git
  revision, snapshot and Electron version.

## Build in Docker

On any Linux with Docker (or Docker Desktop):

```sh
make docker-iso
```

This builds the `aurora-os-builder:24.04` image from `iso/Dockerfile` (Ubuntu 24.04 + build
tools + Node.js 22, checked against the official SHASUMS) and runs `iso/build.sh` in a
**privileged** container (mounts and chroot need it) with the repository mounted at `/src` and
host networking (so a proxy on `localhost` works). Results land in `out/`, owned by you.
The repository must be on a local Linux file system (ext4, xfs, btrfs) that supports overlay
mounts. The same build settings can be passed, e.g. `make docker-iso SNAPSHOT=0`.

## Build settings

Set them on the `make` command line (`make iso NAME=value`) or in the environment
(`sudo NAME=value ./iso/build.sh`). Defaults are in `iso/config.sh`.

| Setting | Default | Meaning |
|---|---|---|
| `SNAPSHOT` | `1` | `1`: pinned snapshot (reproducible); `0`: live archive `archive.ubuntu.com` (newest packages); `auto`: snapshot, falling back to the archive when snapshot.ubuntu.com is unreachable |
| `STAMP` (= `SNAPSHOT_STAMP`) | `20261001T000000Z` | snapshot date, format `YYYYMMDDTHHMMSSZ` |
| `MIRROR` | from the two above | any Ubuntu mirror URL, overrides both |
| `WITH_FIRMWARE` | `0` | `1` adds `linux-firmware` (~600 MB more, needed on real hardware for Wi-Fi/GPUs) |
| `KERNEL_PACKAGE` | `linux-image-generic` | e.g. `linux-image-generic-hwe-24.04` for a newer kernel |
| `INSTALL_RECOMMENDS` | `0` | `1` installs Recommends too (bigger image) |
| `ALLOW_MISSING_PACKAGES` | `0` | `1` skips unknown package names with a warning instead of failing |
| `SQUASHFS_COMP` / `SQUASHFS_LEVEL` | `zstd` / `19` | squashfs compression (`xz` = smaller, slower to boot) |
| `ELECTRON_VERSION` / `ELECTRON_SHA256` | `shell/package.json` / pinned | Electron override (give the zip's SHA-256 for a new version) |
| `SOURCE_DATE_EPOCH` | last commit time | timestamp used for every file in the image |
| `BUILD_CA_BUNDLE` | system CA bundle | CA certificates trusted while downloading |
| `BUILD_ARGS` | | extra `iso/build.sh` options, e.g. `BUILD_ARGS="--from squashfs"` |

Apt packages needed by a feature go in `iso/packages.d/<feature>.list` (one per line, `#`
comments); every list is installed. Files copied verbatim into the image live in `rootfs/`.

## Measured build time and size

Measured on the development build container (4 vCPU Xeon 2.1 GHz, 15 GB RAM, SSD, fast network;
Electron 44.7.0, snapshot `20261001T000000Z`, `WITH_FIRMWARE=0`, October 2026 package lists):

| Build | Time |
|---|---|
| First build, empty `cache/` and `work/` (downloads ~75 MB for debootstrap, ~440 MB of packages, 118 MB Electron) | **10 min 49 s** — base 2:43, packages 4:32, system 0:43, squashfs 2:44, iso 0:06 |
| Rebuild after other features added 4 package lists (installed into the existing layer) | **6 min 00 s** — packages 2:15 |
| Rebuild with unchanged package lists (shell, rootfs or build script changes) | **5 min 18 s** — system 0:41, squashfs 4:21, iso 0:06 |

`mksquashfs` (zstd level 19) dominates rebuilds and scales with the number of cores; it took
2.7 to 4.9 minutes here depending on the image size and the machine's load (other builds and tests ran in parallel). `SQUASHFS_LEVEL=3`
makes it several times faster for development builds, at the cost of a bigger ISO.

| Output | Size |
|---|---|
| ISO (`aurora-os-1.0.0-amd64.iso`) | **753 MiB** (789,237,760 bytes) |
| `casper/filesystem.squashfs` (zstd 19, 1 MiB blocks) | 666 MiB |
| Root file system, uncompressed | 1630 MiB |
| Debian packages in the image | 599 |
| Disk used by the build | `work/` 2.7 GB, `cache/` 0.7 GB (plus the ISO in `out/`) |

## Check the image without a VM

```sh
make verify-iso           # = sudo tools/verify-iso.sh [--iso PATH]
make smoke-image          # = sudo tools/smoke-image.sh [--iso PATH] [--secs 20]
```

`make verify-iso` checks the ISO statically (about 100 checks, a few seconds): SHA-256, El Torito
BIOS and UEFI boot images, GPT with an EFI System Partition and GRUB's MBR code (USB boot), the
EFI loader, `md5sum.txt`, the GRUB menu (`grub-script-check` and every entry's kernel
parameters), the casper files and the initramfs (casper, Plymouth theme, virtio-gpu), then the
content of the squashfs: Electron, `chrome-sandbox` setuid root, the shell and its runtime npm
dependencies, session scripts and helpers, greetd autologin, enabled services
(`systemctl --root`), firewall, locales, permissions, and that no build proxy, build CA,
machine-id or SSH host key was shipped.

Mounts the ISO's `filesystem.squashfs` read-only with a throwaway overlay, starts a private Xvfb
and runs the image's own launchers (`/usr/bin/aurora-shell` and the sign-in screen
`/usr/lib/aurora/aurora-xgreeter`) as a temporary unprivileged user. It checks that Electron's
shared libraries resolve, that the desktop's renderer reaches `body.ready` and that the sign-in
page loads (through the DevTools protocol), and that nothing fatal is printed; then it unmounts
everything. Logs: `work/smoke-logs/`. (Electron runs with `--no-sandbox` there; the real session
keeps the sandbox.)

## Try it in QEMU

Install QEMU (then start the VM as your normal user, not with sudo):

| Host | Packages |
|---|---|
| Ubuntu / Debian | `sudo apt install qemu-system-x86 qemu-system-gui qemu-utils ovmf` |
| Fedora | `sudo dnf install qemu-kvm qemu-ui-gtk qemu-audio-pipewire qemu-img edk2-ovmf` |
| Arch | `sudo pacman -S qemu-desktop edk2-ovmf` |

For speed, use KVM: `ls -l /dev/kvm` must exist and be usable by you
(`sudo usermod -aG kvm $USER`, then log out and in). Without KVM QEMU emulates the CPU (TCG):
it works, but the first boot takes several minutes.

### With the Makefile (recommended)

```sh
make run              # live session, BIOS firmware, + a 32 GB virtual disk to install to
make run-uefi         # the same with UEFI firmware (OVMF)
make run-disk         # after installing (BIOS): boot the virtual disk only
make run-disk-uefi    # after installing in UEFI mode
make run DRY_RUN=1    # only print the QEMU command line
```

`make run` creates `work/qemu/aurora-disk.qcow2` (32 GB, thin-provisioned) on first use and
gives it boot priority over the CD: while the disk is blank the firmware falls through to the
live ISO; once Aurora OS is installed, the next boot starts the installed system even though the
ISO is still attached ("boot once from the CD"). `make run BOOT=cd` forces the live CD first.
In UEFI mode a private copy of the firmware variables is kept in `work/qemu/` so the boot entry
created by the firmware survives. The installer writes both a BIOS and a UEFI boot loader, so the
installed disk boots with either firmware (`make run-disk` or `make run-disk-uefi`).

VM settings: `MEM=4096` (MB), `CPUS=4`, `RES=1920x1080` (initial screen mode; 1600x900 under TCG),
`VGA=virtio` (`VGA=std` = standard VGA, the most compatible), `AUDIO=auto`
(PipeWire, else PulseAudio, else SDL, else none), `DISK=...`, `DISK_SIZE=32G`, `HEADLESS=1`
(no window, sockets in `work/qemu/` for `tools/qmp.py`), `QEMU_ARGS="..."` (passed to
`tools/qemu-run.sh`, see `tools/qemu-run.sh --help`). Example: `make run-uefi MEM=8192 CPUS=6`.

The serial console is written to `work/qemu/aurora.serial.log` (`tail -f` it after choosing the
*debug* boot entry). Without a graphical session the VM screen is served on VNC `127.0.0.1:5900`.

### Plain QEMU commands

The same thing without the helper script (KVM; for TCG replace `-accel kvm -cpu host` with
`-accel tcg,thread=multi -cpu max`):

```sh
ISO=out/aurora-os-1.0.0-amd64.iso
qemu-img create -f qcow2 aurora-disk.qcow2 32G          # once: the disk to install to

# BIOS: live session + installation. The disk comes first in the boot order: while it is blank
# the firmware falls through to the CD; once Aurora OS is installed, the disk boots.
qemu-system-x86_64 -machine q35,vmport=off -accel kvm -cpu host -m 4096 -smp 4 \
  -drive file=aurora-disk.qcow2,if=none,id=hd0,format=qcow2,discard=unmap \
  -device virtio-blk-pci,drive=hd0,bootindex=0 \
  -drive file=$ISO,if=none,id=cd0,media=cdrom,format=raw,readonly=on \
  -device ide-cd,drive=cd0,bus=ide.1,bootindex=1 \
  -vga none -device virtio-vga,xres=1920,yres=1080 -display gtk,zoom-to-fit=on \
  -device qemu-xhci -device usb-tablet \
  -nic user,model=virtio-net-pci \
  -audiodev pipewire,id=snd0 -device intel-hda -device hda-duplex,audiodev=snd0 \
  -serial file:aurora-serial.log

# UEFI: the same, plus the OVMF firmware and a private, writable copy of its variable store.
cp /usr/share/OVMF/OVMF_VARS_4M.fd aurora-vars.fd       # once
qemu-system-x86_64 -machine q35,vmport=off -accel kvm -cpu host -m 4096 -smp 4 \
  -drive if=pflash,format=raw,unit=0,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
  -drive if=pflash,format=raw,unit=1,file=aurora-vars.fd \
  -drive file=aurora-disk.qcow2,if=none,id=hd0,format=qcow2,discard=unmap \
  -device virtio-blk-pci,drive=hd0,bootindex=0 \
  -drive file=$ISO,if=none,id=cd0,media=cdrom,format=raw,readonly=on \
  -device ide-cd,drive=cd0,bus=ide.1,bootindex=1 \
  -vga none -device virtio-vga,xres=1920,yres=1080 -display gtk,zoom-to-fit=on \
  -device qemu-xhci -device usb-tablet \
  -nic user,model=virtio-net-pci \
  -audiodev pipewire,id=snd0 -device intel-hda -device hda-duplex,audiodev=snd0 \
  -serial file:aurora-serial.log

# After the installation, without the ISO (BIOS; for UEFI keep the two pflash drives):
qemu-system-x86_64 -machine q35,vmport=off -accel kvm -cpu host -m 4096 -smp 4 \
  -drive file=aurora-disk.qcow2,if=virtio,format=qcow2,discard=unmap \
  -vga none -device virtio-vga,xres=1920,yres=1080 -display gtk,zoom-to-fit=on \
  -device qemu-xhci -device usb-tablet -nic user,model=virtio-net-pci \
  -audiodev pipewire,id=snd0 -device intel-hda -device hda-duplex,audiodev=snd0
```

OVMF file names on other hosts: Fedora `/usr/share/edk2/ovmf/OVMF_CODE.fd` + `OVMF_VARS.fd`;
Arch `/usr/share/edk2/x64/OVMF_CODE.4m.fd` + `OVMF_VARS.4m.fd`; openSUSE
`/usr/share/qemu/ovmf-x86_64-4m-code.bin` + `ovmf-x86_64-4m-vars.bin` (`tools/qemu-run.sh` finds
them automatically, also through QEMU's firmware descriptors in `/usr/share/qemu/firmware/`).
Use `-audiodev pa,id=snd0` on hosts with PulseAudio or QEMU older than 8.1, and
`-device VGA,xres=1920,yres=1080` instead of `virtio-vga` if the screen stays black.
The ISO's boot loader is not signed for Secure Boot: use OVMF without Secure Boot
(`OVMF_CODE_4M.fd`, not `.secboot`/`.ms`) or disable Secure Boot in the firmware setup.

### On a real PC

Write the ISO to a USB stick (all its data is erased) with
`sudo dd if=out/aurora-os-1.0.0-amd64.iso of=/dev/sdX bs=4M status=progress oflag=sync`
(or Ventoy, balenaEtcher, Rufus in DD mode), disable Secure Boot, and build with
`WITH_FIRMWARE=1` for Wi-Fi and GPU firmware.

## What to expect

1. **Boot menu** (themed GRUB, 8 s timeout): *Aurora OS (English)*, *Aurora OS (Français)*
   (French UI and French keyboard), *Safe graphics / Mode graphique sûr* (`nomodeset`, software
   rendering), *Boot from first hard disk / Démarrer sur le disque dur*, and *Advanced options*:
   *debug* (verbose boot, serial console on ttyS0, `aurora.debug`), *copy to RAM*, *check disc
   for defects*, *UEFI firmware settings* (UEFI only), *Restart*, *Shut down*.
2. **Splash screen** (Aurora logo + spinner), then the **desktop of the live user `aurora`**,
   signed in automatically (no password; administrator rights without password in the live
   session). Nothing is saved across reboots.
3. On the desktop: **This PC**, **Recycle Bin**, `Welcome.txt` (English/French) and the
   **Install Aurora OS** icon (live session only, see [Install Aurora OS](#install-aurora-os)),
   the taskbar and the Start menu. Signing out shows the Aurora sign-in screen.
4. In the VM, the screen switches to 1920x1080 (KVM) or 1600x900 (TCG) automatically; the
   network works out of the box (QEMU user networking, NAT).

Boot time: with KVM, expect well under a minute to the desktop. Under TCG emulation (no KVM,
4 vCPUs) an earlier test reached the automatic sign-in after about 2.5 minutes and the desktop
about 30 seconds later.

## Install Aurora OS

In the live session, open **Install Aurora OS** (desktop icon, or Start → All apps). The installer
looks like Windows 11 Setup, speaks English and French (the language chosen on the first page
switches it at once and becomes the installed system's language) and follows the light/dark theme.

1. **Language** — English or Français.
2. **Keyboard** — the layout is applied to the live session right away, so the test field shows
   what your keys produce.
3. **Disk** — Aurora OS uses a **whole disk, which is erased**. Disks smaller than 12 GB are shown
   but cannot be chosen; the live medium, read-only, loop, zram and in-use disks are not listed.
4. **Account** — your name, a user name (derived from the first name, editable), password +
   confirmation (with a strength hint), computer name, and *Sign in automatically*. The account
   is an administrator (group `sudo`).
5. **Time zone** — searchable list (default Europe/Paris in French, America/New_York in English).
6. **Summary** — every choice with a *Change* link. **Install** asks for confirmation before the
   disk is erased.

The progress page lists the stages, shows the percentage and, with *Show details*, the live log.
*Cancel* (or closing the window) asks first, then stops cleanly: everything is unmounted, but the
disk stays unusable until an installation succeeds. At the end, **Restart now** reboots (remove the
ISO first if your firmware starts the CD before the disk; `make run` already boots the disk first).
On an error the page shows the message and the last lines of the log, and *Try again* goes back to
the summary.

The work is done by `/usr/lib/aurora/helpers/aurora-install` (root, started with `sudo -n`; the
live user has passwordless sudo from casper; the password goes through stdin, never the command
line):

| Stage | What happens |
|---|---|
| partition | `wipefs`, then GPT: 1 MiB BIOS boot partition, 512 MiB EFI System Partition (FAT32, label `EFI`), the rest ext4 (label `AURORA`) |
| copy | `unsquashfs` of `/cdrom/casper/filesystem.squashfs` (or `rsync` of `/rofs`), with progress |
| configure | `/etc/fstab` by UUID; host name; live user, casper's sudo rule and `/etc/casper.conf` removed; live-only packages (`casper/filesystem.manifest-remove`: casper, user-setup, …) purged offline with `dpkg --purge`; locale, keyboard (`/etc/default/keyboard`), time zone; the account (groups sudo, adm, users, netdev, audio, video, plugdev) and its `~/.config/aurora/settings.json` (language); greetd without the live autologin (or `[initial_session]` for the account); new machine-id; initramfs regenerated without casper |
| bootloader | GRUB for **BIOS** on the disk **and** for **UEFI** on the ESP: Ubuntu's signed shim + GRUB in `EFI/ubuntu` and on the removable path `EFI/BOOT/BOOTX64.EFI` (no NVRAM writes, so the disk boots on any UEFI machine); Aurora GRUB theme; `/etc/default/grub.d/50-aurora.cfg` (`GRUB_DISTRIBUTOR="Aurora OS"`, `quiet splash`, 3 s menu); `update-grub` |
| cleanup | log copied to the installed system, `sync`, unmount |

Logs: `/var/log/aurora-install.log` in the live session, copied to `/var/log/aurora-install.log`
on the installed system. Measured on the build container (4 vCPUs, loop device): the whole
installation takes 50–65 s, most of it the initramfs; expect a few minutes in a VM under TCG.
`sudo /usr/lib/aurora/helpers/aurora-install --help` documents the command line (`--json`
progress, `--dry-run`, `--source`, `--fail-at` for testing error handling).

### Test the installer without a VM

The helper can install to a disk image attached to a loop device, using the squashfs of a build:

```sh
make iso                                             # only if work/iso is missing or outdated
truncate -s 24G /tmp/aurora-disk.img
LOOP=$(sudo losetup -fP --show /tmp/aurora-disk.img) # -P: partition devices (${LOOP}p1…)
printf 'my password\n' | sudo rootfs/usr/lib/aurora/helpers/aurora-install --disk "$LOOP" \
  --user jane --fullname "Jane Doe" --password-stdin --lang fr --keyboard 'fr(oss)' \
  --timezone Europe/Paris --source "$PWD/work/iso/casper/filesystem.squashfs"
sudo sgdisk -p "$LOOP"; sudo blkid "${LOOP}"p*      # GPT + file systems
sudo mount -o ro "${LOOP}p3" /mnt && cat /mnt/etc/fstab && sudo umount /mnt
sudo losetup -d "$LOOP"; rm /tmp/aurora-disk.img
```

The default `--medium` is two levels above a squashfs `--source` (here `work/iso`: GRUB theme and
`filesystem.manifest-remove`). On a kernel without FAT support (containers) the EFI partition is
staged on a tmpfs and written with `mtools`; an `--source` directory needs `rsync`. The UI and the
helper's protocol are tested by `cd shell && xvfb-run -a -s "-screen 0 1600x900x24" node
test/installer.test.mjs` (dry run, nothing is written).

## Automated install

For virtual machines and labs, the live ISO installs itself without any interaction when the kernel
command line contains `aurora.autoinstall=1`: `aurora-autoinstall.service` runs the same helper
before the sign-in screen, then powers the machine off. **The target disk is erased.**

| Parameter | Default | Meaning |
|---|---|---|
| `aurora.autoinstall=1` | — | enable (required) |
| `aurora.autoinstall.disk=/dev/vda` | the only eligible disk | disk to erase; refused when several disks qualify |
| `aurora.autoinstall.user=` | `aurora` | account name |
| `aurora.autoinstall.password=` | `aurora` | password (`%20` for a space). Readable in `/proc/cmdline` during the live session: **test passwords only** |
| `aurora.autoinstall.fullname=` | `Aurora User` | full name, `+` or `%20` for spaces |
| `aurora.autoinstall.hostname=` | `<user>-pc` | computer name |
| `aurora.autoinstall.lang=` | `en` | `en` or `fr` |
| `aurora.autoinstall.keyboard=` | `us` (`fr` with lang=fr) | e.g. `fr(oss)`, `ch(fr)`, `de` |
| `aurora.autoinstall.timezone=` | `UTC` (`Europe/Paris` with lang=fr) | `Area/City` |
| `aurora.autoinstall.autologin=1` | off | sign the account in automatically |
| `aurora.autoinstall.finish=` | `poweroff` | `poweroff`, `reboot` or `none` (the live session starts) |
| `aurora.autoinstall.force=1` | off | install even if the disk already holds a complete installation |

```sh
# QEMU, direct kernel boot (no GRUB): install, power off, then boot the installed disk
make run QEMU_ARGS="--kernel 'aurora.autoinstall=1 aurora.autoinstall.disk=/dev/vda aurora.autoinstall.lang=fr aurora.autoinstall.password=test'"
make run-disk            # or: make run-disk-uefi (the disk has BIOS and UEFI boot loaders)
make run DRY_RUN=1 QEMU_ARGS="--kernel 'aurora.autoinstall=1'"   # just print the QEMU command
```

From the boot menu instead: highlight *Aurora OS (English)*, press `e`, add the parameters before
`---` on the `linux` line and press Ctrl+X (or F10). Progress appears on the boot splash, on the
VM screen, on the serial console (`tail -f work/qemu/aurora.serial.log`; `--kernel` adds
`console=ttyS0`) and in `journalctl -u aurora-autoinstall`; the full log is
`/var/log/aurora-install.log`.

Safety: the unit only runs when the command line has `aurora.autoinstall=1` **and** `boot=casper`
**and** `/cdrom/casper` exists (live medium); the script checks the live medium again, and the
installer removes the unit from the installed system, so an installed Aurora OS can never
reinstall itself. If the disk already holds a complete installation (ext4 labelled `AURORA` whose
`/etc/aurora/install-info` has the `AURORA_INSTALL_COMPLETE` line the installer writes last), the
automated installation is skipped unless `aurora.autoinstall.force=1` — a VM that keeps booting
the ISO (direct kernel boot always does) never reinstalls in a loop, while an interrupted
installation is retried. On failure the live session starts and the error stays on the console. Details: `/usr/lib/aurora/autoinstall/README` in the image.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Could not access KVM kernel module` / "KVM not available — using TCG" | enable VT-x/AMD-V in the PC's firmware; `sudo modprobe kvm_intel` (or `kvm_amd`); `sudo usermod -aG kvm $USER` and log in again; check `ls -l /dev/kvm` |
| Very slow boot | that is TCG (no KVM). Give it more cores (`CPUS=`), keep `MEM=4096`+, be patient on the first boot; the boot menu's default entry works, *copy to RAM* does not help under TCG |
| Black screen after the splash | choose **Safe graphics** in the boot menu; in QEMU try `make run VGA=std`; the *debug* entry logs everything to `work/qemu/aurora.serial.log` |
| Desktop does not appear, back to a sign-in screen | boot the *debug* entry and look for `aurora-session`/`aurora-shell` lines in the serial log; or open a text console (Ctrl+Alt+F1 — in the QEMU window use *Machine → Send key* if the host catches it; user `aurora`, empty password) and run `journalctl -b -t aurora-session -t aurora-greeter` |
| UEFI VM goes to the UEFI shell or does not find the ISO | Secure Boot firmware selected: use `OVMF_CODE_4M.fd` (`make run-uefi` does) |
| Installed VM does not boot | the disk has BIOS and UEFI boot loaders: check that the disk comes first (`make run-disk`, `make run-disk-uefi`); read `/var/log/aurora-install.log` (live session, also copied to the installed system) |
| Installer: "Administrator rights are required" | the helper runs with `sudo -n`: only the live user (passwordless sudo from casper) can install; in a terminal use `sudo /usr/lib/aurora/helpers/aurora-install …` |
| Installer: a disk is missing from the list | disks under 12 GB, the live medium, read-only, loop/zram and in-use (mounted outside `/media`, LVM/RAID) disks are not offered |
| `OVMF ... not found` | install `ovmf` (Ubuntu/Debian), `edk2-ovmf` (Fedora/Arch), or set `OVMF_CODE=... OVMF_VARS=...` |
| No sound in the VM | `make run AUDIO=pa` or `AUDIO=sdl`; on Ubuntu install `qemu-system-gui` (audio and gtk display modules) |
| Build: `missing packages` report | a name in `iso/packages.d/*.list` does not exist in noble: fix it (check with `apt-cache policy <name>`), or `ALLOW_MISSING_PACKAGES=1` |
| Build: snapshot mirror unreachable | check the proxy/network; `make iso SNAPSHOT=auto` (fallback) or `SNAPSHOT=0` |
| Build: `another build is running` | another `iso/build.sh` holds `work/.build.lock`; wait for it |
| Build: disk full | free space (≥ 15 GB recommended), `make clean`; `cache/` can be deleted too |
| Build interrupted with mounts left (machine crash) | `make clean` unmounts everything under `work/` |

---

## Version française

Aurora OS est livré sous la forme d'une image ISO hybride (`out/aurora-os-<version>-amd64.iso`)
qui démarre en BIOS et en UEFI, depuis un DVD, une clé USB ou une machine virtuelle. Elle lance
une session live (rien n'est écrit sur le disque) depuis laquelle on peut installer Aurora OS.

### Prérequis

- Une machine **Ubuntu 24.04** (ou Debian 12+/Ubuntu 22.04+) x86-64 avec les droits **root**
  (`sudo`) : la construction utilise `debootstrap`, `chroot` et des montages overlay.
- Environ **25 Go libres** dans le système de fichiers du dépôt, 4 Go de RAM ou plus.
- Un accès réseau à `snapshot.ubuntu.com` (HTTPS) et à `github.com` (téléchargement d'Electron).
  Derrière un proxy, exportez `https_proxy`/`http_proxy` ; pour un proxy qui intercepte le TLS,
  indiquez aussi `BUILD_CA_BUNDLE=/chemin/ca.pem`. Proxy et certificat ne servent que pendant la
  construction et ne sont jamais copiés dans l'image (la construction le vérifie).
- Les outils :

  ```sh
  sudo apt-get install debootstrap ubuntu-keyring squashfs-tools xorriso mtools dosfstools \
       grub-common grub-pc-bin grub-efi-amd64-bin librsvg2-bin imagemagick unzip curl zstd git
  ```

  et **Node.js 22** (cherché dans `/opt/node22/bin`, modifiable avec `NODE_BIN=...`, puis dans le `PATH`).

Sans machine Ubuntu/Debian, utilisez [Docker](#construire-avec-docker).

### Construire l'ISO

Depuis le dossier `aurora-os/` :

```sh
make iso
```

C'est toute la construction (elle lance `sudo ./iso/build.sh`). Résultats dans `out/` : l'ISO
`aurora-os-1.0.0-amd64.iso`, sa somme `…iso.sha256` (`sha256sum -c` dans `out/`) et la liste des
paquets `…manifest`. Les fichiers appartiennent à l'utilisateur qui a lancé `make`. Le journal
complet est dans `work/logs/latest.log`.

Étapes (`iso/build.sh`, réglages dans `iso/config.sh`) : `base` (debootstrap depuis l'instantané
figé, mis en cache), `packages` (installation de toutes les listes `iso/packages.d/*.list` ; un nom
de paquet inconnu arrête la construction avec un rapport clair), `system` (Electron vérifié par
SHA-256, `chrome-sandbox` setuid, profil AppArmor, Aurora Shell dans `/opt/aurora/shell` avec
`npm ci --omit=dev`, recopie de `rootfs/`, langues en_US/fr_FR, utilisateur live, greetd,
services, pare-feu, écran de démarrage Plymouth, initramfs, vérifications), `squashfs`, puis
`iso` (menu GRUB thématisé, ISO hybride BIOS+UEFI).

Les reconstructions sont incrémentales : le système de base et la couche de paquets sont réutilisés
tant que leurs entrées ne changent pas ; un paquet ajouté à une liste est installé dans la couche
existante. Options utiles (`make iso BUILD_ARGS="..."`) : `--until <étape>`, `--from <étape>`,
`--rebuild-packages`, `--clean`. `make clean` supprime `work/` sauf le disque de la VM
(`work/qemu/`), `make clean-vm` supprime ce disque, `make distclean` supprime `work/`, `cache/`
et `out/`. Tous les montages sont défaits à la fin, même après une erreur ou un Ctrl+C.

Reproductibilité : paquets issus d'un instantané daté de l'archive Ubuntu, Electron vérifié contre
le `SHASUMS256.txt` de la version **et** la somme figée dans `iso/config.sh`, dépendances npm
figées par `package-lock.json`, dates des fichiers ramenées à `SOURCE_DATE_EPOCH` (dernier commit).
`/etc/aurora/build-id` et `/etc/aurora/build-info` identifient la construction.

### Construire avec Docker

```sh
make docker-iso
```

Construit l'image `aurora-os-builder:24.04` (`iso/Dockerfile` : Ubuntu 24.04, outils, Node.js 22
vérifié) puis lance `iso/build.sh` dans un conteneur **privilégié** (nécessaire pour les
montages et le chroot), dépôt monté sur `/src`, réseau de l'hôte. Le dépôt doit se trouver sur un
système de fichiers Linux local (ext4, xfs, btrfs). Les mêmes réglages s'appliquent
(`make docker-iso SNAPSHOT=0`).

### Réglages de construction

`make iso NOM=valeur` ou `sudo NOM=valeur ./iso/build.sh` :

| Réglage | Défaut | Rôle |
|---|---|---|
| `SNAPSHOT` | `1` | `1` : instantané figé (reproductible) ; `0` : archive à jour `archive.ubuntu.com` ; `auto` : instantané, ou l'archive si snapshot.ubuntu.com est injoignable |
| `STAMP` (= `SNAPSHOT_STAMP`) | `20261001T000000Z` | date de l'instantané |
| `MIRROR` | — | miroir Ubuntu imposé |
| `WITH_FIRMWARE` | `0` | `1` ajoute `linux-firmware` (~600 Mo, utile sur une vraie machine) |
| `KERNEL_PACKAGE` | `linux-image-generic` | ex. `linux-image-generic-hwe-24.04` |
| `INSTALL_RECOMMENDS` | `0` | `1` installe aussi les paquets recommandés |
| `ALLOW_MISSING_PACKAGES` | `0` | `1` ignore les paquets inconnus (avertissement) |
| `SQUASHFS_COMP` / `SQUASHFS_LEVEL` | `zstd` / `19` | compression du squashfs |
| `ELECTRON_VERSION` / `ELECTRON_SHA256` | `package.json` / figée | autre version d'Electron (donner la somme SHA-256 du zip) |
| `SOURCE_DATE_EPOCH` | date du dernier commit | date appliquée aux fichiers de l'image |
| `BUILD_CA_BUNDLE` | certificats du système | autorités de confiance pendant les téléchargements |

Les paquets apt d'une fonctionnalité vont dans `iso/packages.d/<fonction>.list` ; les fichiers
copiés tels quels dans l'image sont dans `rootfs/`.

### Durée et taille mesurées

Mesures sur le conteneur de développement (4 vCPU Xeon 2,1 GHz, 15 Go de RAM, SSD, réseau rapide) :

| Construction | Durée |
|---|---|
| Première construction, `cache/` et `work/` vides (~75 Mo pour debootstrap, ~440 Mo de paquets, 118 Mo pour Electron) | **10 min 49 s** |
| Après l'ajout de 4 listes de paquets (installés dans la couche existante) | **6 min 00 s** |
| Listes de paquets inchangées (modification du shell, de `rootfs/` ou des scripts) | **5 min 18 s** |

`mksquashfs` (zstd niveau 19) domine les reconstructions (2,7 à 4,9 min selon la taille de l'image et la charge de la machine) ; `SQUASHFS_LEVEL=3`
accélère beaucoup les constructions de développement (ISO plus grosse). Tailles : ISO **753 Mio**
(789 237 760 octets), squashfs 666 Mio, système de fichiers décompressé 1630 Mio, 599 paquets ;
la construction occupe 2,7 Go dans `work/` et 0,7 Go dans `cache/`.

### Vérifier l'image sans VM

`make verify-iso` vérifie l'ISO sans la démarrer (une centaine de contrôles : enregistrements de
démarrage BIOS et UEFI, GPT et partition EFI, menu GRUB et paramètres du noyau, fichiers casper,
initramfs, contenu du squashfs, services activés, permissions, absence de proxy/certificat de
construction, de machine-id et de clés SSH). `make smoke-image` monte le `filesystem.squashfs` de l'ISO en lecture seule, lance un Xvfb privé
et exécute les lanceurs de l'image (bureau et écran de connexion) avec un utilisateur temporaire :
bibliothèques d'Electron toutes présentes, rendu du bureau jusqu'à `body.ready`, page de connexion
chargée, aucune erreur fatale ; puis tout est démonté. Journaux : `work/smoke-logs/`.

### Essayer dans QEMU

Installez QEMU (Ubuntu/Debian : `sudo apt install qemu-system-x86 qemu-system-gui qemu-utils
ovmf` ; Fedora : `sudo dnf install qemu-kvm qemu-ui-gtk qemu-audio-pipewire qemu-img edk2-ovmf` ;
Arch : `sudo pacman -S qemu-desktop edk2-ovmf`) et lancez la VM **sans sudo**. Pour la vitesse,
KVM doit être utilisable (`ls -l /dev/kvm`, `sudo usermod -aG kvm $USER` puis reconnexion) ;
sinon QEMU émule le processeur (TCG) : ça marche, mais le premier démarrage prend plusieurs minutes.

```sh
make run              # session live, BIOS, + disque virtuel de 32 Go pour l'installation
make run-uefi         # idem en UEFI (OVMF)
make run-disk         # après installation (BIOS) : démarre le disque seul
make run-disk-uefi    # après une installation en UEFI
make run DRY_RUN=1    # affiche seulement la commande QEMU
```

`make run` crée `work/qemu/aurora-disk.qcow2` (32 Go, alloué à la demande) et lui donne la
priorité de démarrage : tant qu'il est vide, le micrologiciel passe au CD live ; une fois Aurora OS
installé, la VM démarre sur le disque même si l'ISO est encore branchée (« démarrage unique sur le
CD »). `make run BOOT=cd` force le CD. En UEFI, une copie privée des variables du micrologiciel
est gardée dans `work/qemu/`. L'installateur écrit un chargeur de démarrage BIOS **et** UEFI : le
disque installé démarre avec les deux (`make run-disk` ou `make run-disk-uefi`).

Réglages : `MEM=4096`, `CPUS=4`, `RES=1920x1080`, `VGA=virtio` (`VGA=std` = VGA standard, le plus
compatible), `AUDIO=auto` (PipeWire, sinon PulseAudio, sinon SDL, sinon aucun), `DISK=...`,
`DISK_SIZE=32G`, `HEADLESS=1`, `QEMU_ARGS="..."` (voir `tools/qemu-run.sh --help`). La console
série est écrite dans `work/qemu/aurora.serial.log` (entrée *débogage* du menu). Sans session
graphique, l'écran de la VM est servi en VNC sur `127.0.0.1:5900`.

Les commandes QEMU complètes sans script (BIOS et UEFI) sont dans la
[section anglaise](#plain-qemu-commands) ; elles sont identiques. Le chargeur de l'ISO n'est pas
signé pour Secure Boot : utilisez OVMF sans Secure Boot (`OVMF_CODE_4M.fd`) ou désactivez Secure
Boot. Sur un vrai PC : copiez l'ISO sur une clé USB (`dd`, Ventoy, balenaEtcher, Rufus en mode DD)
et construisez avec `WITH_FIRMWARE=1`.

### Ce que vous verrez

1. **Menu de démarrage** (GRUB thématisé, 8 s) : *Aurora OS (English)*, *Aurora OS (Français)*
   (interface et clavier français), *Safe graphics / Mode graphique sûr* (`nomodeset`, rendu
   logiciel), *Démarrer sur le disque dur*, et *Options avancées* : *débogage* (démarrage
   détaillé, console série ttyS0, `aurora.debug`), *copier en mémoire*, *vérifier le disque*,
   *paramètres UEFI*, *redémarrer*, *arrêter*.
2. **Écran de démarrage** (logo Aurora), puis le **bureau de l'utilisateur live `aurora`**, connecté
   automatiquement (sans mot de passe ; droits d'administrateur sans mot de passe en session live).
   Rien n'est conservé au redémarrage.
3. Sur le bureau : **Ce PC**, **Corbeille**, `Welcome.txt` (anglais/français) et l'icône
   **Installer Aurora OS** (session live uniquement, voir [Installer Aurora OS](#installer-aurora-os)),
   la barre des tâches et le menu Démarrer. Se déconnecter affiche l'écran de connexion.
4. Dans la VM, l'écran passe en 1920x1080 (KVM) ou 1600x900 (TCG) ; le réseau fonctionne
   directement (NAT de QEMU).

Durée de démarrage : avec KVM, nettement moins d'une minute jusqu'au bureau. En émulation TCG
(sans KVM, 4 vCPU), un essai précédent a atteint la connexion automatique en 2 min 30 environ et
le bureau une trentaine de secondes plus tard.

### Installer Aurora OS

Dans la session live, ouvrez **Installer Aurora OS** (icône du bureau, ou Démarrer → Toutes les
applications). L'installateur ressemble au programme d'installation de Windows 11, parle anglais et
français (la langue choisie en première page change l'interface immédiatement et devient celle du
système installé) et suit le thème clair/sombre.

1. **Langue** — English ou Français.
2. **Clavier** — la disposition est appliquée tout de suite à la session live : le champ de test
   montre ce que produisent vos touches.
3. **Disque** — Aurora OS utilise un **disque entier, qui est effacé**. Les disques de moins de
   12 Go sont affichés mais pas sélectionnables ; le support live, les disques en lecture seule,
   loop, zram ou utilisés ne sont pas proposés.
4. **Compte** — votre nom, un nom d'utilisateur (déduit du prénom, modifiable), mot de passe +
   confirmation (avec indication de robustesse), nom de l'ordinateur et *Se connecter
   automatiquement*. Le compte est administrateur (groupe `sudo`).
5. **Fuseau horaire** — liste avec recherche (Europe/Paris par défaut en français,
   America/New_York en anglais).
6. **Récapitulatif** — chaque choix avec un lien *Modifier*. **Installer** demande confirmation
   avant d'effacer le disque.

La page de progression liste les étapes, affiche le pourcentage et, avec *Afficher les détails*, le
journal en direct. *Annuler* (ou fermer la fenêtre) demande confirmation puis arrête proprement :
tout est démonté, mais le disque reste inutilisable tant qu'une installation n'a pas réussi. À la
fin, **Redémarrer maintenant** redémarre (retirez l'ISO si votre micrologiciel démarre le CD avant
le disque ; `make run` démarre déjà le disque en premier). En cas d'erreur, la page affiche le
message et les dernières lignes du journal ; *Réessayer* revient au récapitulatif.

Le travail est fait par `/usr/lib/aurora/helpers/aurora-install` (root, lancé avec `sudo -n` ;
l'utilisateur live a sudo sans mot de passe grâce à casper ; le mot de passe passe par l'entrée
standard, jamais par la ligne de commande) :

| Étape | Ce qui est fait |
|---|---|
| partition | `wipefs`, puis GPT : partition BIOS boot de 1 Mio, partition système EFI de 512 Mio (FAT32, étiquette `EFI`), le reste en ext4 (étiquette `AURORA`) |
| copy | `unsquashfs` de `/cdrom/casper/filesystem.squashfs` (ou `rsync` de `/rofs`), avec progression |
| configure | `/etc/fstab` par UUID ; nom d'hôte ; suppression de l'utilisateur live, de la règle sudo de casper et de `/etc/casper.conf` ; purge hors ligne (`dpkg --purge`) des paquets propres au live (`casper/filesystem.manifest-remove` : casper, user-setup…) ; langue, clavier (`/etc/default/keyboard`), fuseau ; le compte (groupes sudo, adm, users, netdev, audio, video, plugdev) et son `~/.config/aurora/settings.json` (langue) ; greetd sans la connexion automatique du live (ou `[initial_session]` pour le compte) ; nouveau machine-id ; initramfs régénéré sans casper |
| bootloader | GRUB pour le **BIOS** sur le disque **et** pour l'**UEFI** sur l'ESP : shim + GRUB signés d'Ubuntu dans `EFI/ubuntu` et sur le chemin amovible `EFI/BOOT/BOOTX64.EFI` (sans écrire dans la NVRAM : le disque démarre sur toute machine UEFI) ; thème GRUB Aurora ; `/etc/default/grub.d/50-aurora.cfg` (`GRUB_DISTRIBUTOR="Aurora OS"`, `quiet splash`, menu 3 s) ; `update-grub` |
| cleanup | copie du journal sur le système installé, `sync`, démontage |

Journal : `/var/log/aurora-install.log` dans la session live, copié dans `/var/log/aurora-install.log`
du système installé. Mesuré sur le conteneur de construction (4 vCPU, périphérique loop) :
l'installation complète prend 50 à 65 s, surtout pour l'initramfs ; comptez quelques minutes dans
une VM en TCG. `sudo /usr/lib/aurora/helpers/aurora-install --help` décrit la ligne de commande
(progression `--json`, `--dry-run`, `--source`, `--fail-at` pour tester la gestion des erreurs).

Tester l'installateur sans VM : les commandes `truncate` / `losetup -fP` / `aurora-install
--source work/iso/casper/filesystem.squashfs` de la [section anglaise](#test-the-installer-without-a-vm)
installent dans une image disque ; `cd shell && xvfb-run -a -s "-screen 0 1600x900x24" node
test/installer.test.mjs` teste l'interface et le protocole (simulation, rien n'est écrit).

### Installation automatisée

Pour les machines virtuelles et les salles de test, l'ISO live s'installe toute seule quand la ligne
de commande du noyau contient `aurora.autoinstall=1` : `aurora-autoinstall.service` lance le même
programme avant l'écran de connexion, puis éteint la machine. **Le disque cible est effacé.**

| Paramètre | Par défaut | Rôle |
|---|---|---|
| `aurora.autoinstall=1` | — | active l'installation (obligatoire) |
| `aurora.autoinstall.disk=/dev/vda` | le seul disque éligible | disque à effacer ; refusé si plusieurs disques conviennent |
| `aurora.autoinstall.user=` | `aurora` | nom du compte |
| `aurora.autoinstall.password=` | `aurora` | mot de passe (`%20` pour une espace). Lisible dans `/proc/cmdline` pendant la session live : **mots de passe de test uniquement** |
| `aurora.autoinstall.fullname=` | `Aurora User` | nom complet, `+` ou `%20` pour les espaces |
| `aurora.autoinstall.hostname=` | `<user>-pc` | nom de l'ordinateur |
| `aurora.autoinstall.lang=` | `en` | `en` ou `fr` |
| `aurora.autoinstall.keyboard=` | `us` (`fr` si lang=fr) | par ex. `fr(oss)`, `ch(fr)`, `de` |
| `aurora.autoinstall.timezone=` | `UTC` (`Europe/Paris` si lang=fr) | `Zone/Ville` |
| `aurora.autoinstall.autologin=1` | non | connexion automatique du compte |
| `aurora.autoinstall.finish=` | `poweroff` | `poweroff`, `reboot` ou `none` (la session live démarre) |
| `aurora.autoinstall.force=1` | non | installe même si le disque contient déjà une installation complète |

```sh
# QEMU, démarrage direct du noyau (sans GRUB) : installation, arrêt, puis démarrage du disque installé
make run QEMU_ARGS="--kernel 'aurora.autoinstall=1 aurora.autoinstall.disk=/dev/vda aurora.autoinstall.lang=fr aurora.autoinstall.password=test'"
make run-disk            # ou : make run-disk-uefi (le disque a les chargeurs BIOS et UEFI)
```

Depuis le menu de démarrage : sélectionnez *Aurora OS (Français)*, appuyez sur `e`, ajoutez les
paramètres avant `---` sur la ligne `linux`, puis Ctrl+X (ou F10). La progression s'affiche sur
l'écran de démarrage, l'écran de la VM, la console série (`tail -f work/qemu/aurora.serial.log`) et
dans `journalctl -u aurora-autoinstall` ; le journal complet est `/var/log/aurora-install.log`.

Sécurité : le service ne s'exécute que si la ligne de commande contient `aurora.autoinstall=1`
**et** `boot=casper` **et** que `/cdrom/casper` existe (support live) ; le script revérifie le
support live et l'installateur retire le service du système installé : un Aurora OS installé ne
peut jamais se réinstaller. Si le disque contient déjà une installation complète (ext4 étiqueté
`AURORA` dont `/etc/aurora/install-info` contient la ligne `AURORA_INSTALL_COMPLETE` écrite en
dernier par l'installateur), l'installation automatisée est ignorée sauf avec
`aurora.autoinstall.force=1` : une VM qui redémarre sur l'ISO (toujours le cas avec `--kernel`) ne
se réinstalle pas en boucle, et une installation interrompue est reprise. En cas d'échec, la
session live démarre et l'erreur reste affichée sur la console.

### Dépannage

| Problème | Solution |
|---|---|
| « KVM not available — using TCG » | activer VT-x/AMD-V dans le BIOS/UEFI du PC, `sudo modprobe kvm_intel` (ou `kvm_amd`), `sudo usermod -aG kvm $USER` puis se reconnecter |
| Démarrage très lent | c'est TCG (sans KVM) : plus de cœurs (`CPUS=`), `MEM=4096` ou plus, patience au premier démarrage |
| Écran noir après le logo | entrée **Mode graphique sûr** ; dans QEMU `make run VGA=std` ; l'entrée *débogage* journalise tout dans `work/qemu/aurora.serial.log` |
| Le bureau n'apparaît pas | entrée *débogage*, lignes `aurora-session`/`aurora-shell` du journal série ; ou console texte (Ctrl+Alt+F1 — dans la fenêtre QEMU, *Machine → Send key* si l'hôte intercepte la touche ; utilisateur `aurora`, mot de passe vide) puis `journalctl -b -t aurora-session -t aurora-greeter` |
| La VM UEFI tombe dans le shell UEFI | micrologiciel Secure Boot choisi : prendre `OVMF_CODE_4M.fd` (`make run-uefi` le fait) |
| La VM installée ne démarre pas | le disque a les chargeurs BIOS et UEFI : vérifier qu'il démarre en premier (`make run-disk`, `make run-disk-uefi`) ; lire `/var/log/aurora-install.log` (session live, copié aussi sur le système installé) |
| Installateur : « Des droits d'administrateur sont nécessaires » | le programme est lancé avec `sudo -n` : seul l'utilisateur live (sudo sans mot de passe) peut installer ; en terminal, `sudo /usr/lib/aurora/helpers/aurora-install …` |
| Installateur : un disque n'apparaît pas | les disques de moins de 12 Go, le support live, les disques en lecture seule, loop/zram ou utilisés (montés hors de `/media`, LVM/RAID) ne sont pas proposés |
| Pas de son | `make run AUDIO=pa` ou `AUDIO=sdl` ; sous Ubuntu installer `qemu-system-gui` |
| Construction : `missing packages` | corriger le nom dans `iso/packages.d/*.list` (`apt-cache policy <nom>`) ou `ALLOW_MISSING_PACKAGES=1` |
| Construction : instantané injoignable | vérifier réseau/proxy ; `make iso SNAPSHOT=auto` ou `SNAPSHOT=0` |
| Construction : disque plein | libérer de la place (15 Go conseillés), `make clean` ; `cache/` peut aussi être supprimé |
| Montages restés après un plantage | `make clean` démonte tout ce qui se trouve sous `work/` |
