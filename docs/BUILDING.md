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
- [Troubleshooting](#troubleshooting)

## Prerequisites

- An **Ubuntu 24.04** (or Debian 12+/Ubuntu 22.04+) x86-64 host with **root** access (`sudo`).
  The build uses `debootstrap`, `chroot`, overlay and loop mounts.
- About **25 GB free** in the repository's file system (work tree ~3 GB, download cache ~1 GB,
  ISO ~0.7 GB; the first build needs more temporary space than rebuilds), 4 GB RAM or more.
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

Measured on the build container used for development (4 vCPU Xeon 2.1 GHz, 15 GB RAM, SSD,
fast network; Electron 44.7.0, snapshot `20261001T000000Z`, `WITH_FIRMWARE=0`):

| Build | Time |
|---|---|
| First build, empty cache (downloads ~500 MB of packages + Electron) | **MEASURE_COLD** |
| Rebuild with nothing changed in the package lists (system + squashfs + iso stages) | **MEASURE_WARM** |
| Rebuild after adding a package to a list | **MEASURE_INCR** |

| Output | Size |
|---|---|
| ISO | **MEASURE_ISO** |
| `casper/filesystem.squashfs` (zstd 19) | **MEASURE_SQUASH** |
| Installed size of the root file system | **MEASURE_ROOTFS** |
| Packages in the image | **MEASURE_PKGS** |

Most of the first build is `apt-get install` (network and dpkg) and `mksquashfs` (CPU bound:
more cores = faster).

## Check the image without a VM

```sh
make smoke-image          # = sudo tools/smoke-image.sh  [--iso PATH] [--secs 20]
```

Mounts the ISO's `filesystem.squashfs` read-only with a throwaway overlay, starts a private Xvfb
and runs the image's own launchers (`/usr/bin/aurora-shell` and the sign-in screen
`/usr/lib/aurora/aurora-xgreeter`) as a temporary unprivileged user. It checks that Electron's
shared libraries resolve, that the desktop's renderer reaches `body.ready` and that the sign-in
page loads (through the DevTools protocol), and that nothing fatal is printed; then it unmounts
everything. Logs: `work/smoke-logs/`. (Electron runs with `--no-sandbox` there; the real session
keeps the sandbox.)

## Try it in QEMU

Install QEMU **as your normal user** (do not run the VM with sudo):

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
created by the installer survives. Use the same mode (BIOS or UEFI) for installing and running.

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
qemu-img create -f qcow2 aurora-disk.qcow2 32G          # once

# BIOS: live session + installation (disk first: a blank disk falls through to the CD)
qemu-system-x86_64 -machine q35,vmport=off -accel kvm -cpu host -m 4096 -smp 4 \
  -drive file=aurora-disk.qcow2,if=none,id=hd0,format=qcow2,discard=unmap \
  -device virtio-blk-pci,drive=hd0,bootindex=0 \
  -drive file=$ISO,if=none,id=cd0,media=cdrom,format=raw,readonly=on \
  -device ide-cd,drive=cd0,bus=ide.1,bootindex=1 \
  -vga none -device virtio-vga,xres=1920,yres=1080 -display gtk,zoom-to-fit=on \
  -device qemu-xhci -device usb-tablet \
  -nic user,model=virtio-net-pci \
  -audiodev pipewire,id=snd0 -device intel-hda -device hda-duplex,audiodev=snd0

# UEFI: copy the variable store once, then add the two pflash drives to the command above
cp /usr/share/OVMF/OVMF_VARS_4M.fd aurora-vars.fd        # Fedora: /usr/share/edk2/ovmf/OVMF_VARS.fd
                                                         # Arch:   /usr/share/edk2/x64/OVMF_VARS.4m.fd
  -drive if=pflash,format=raw,unit=0,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
  -drive if=pflash,format=raw,unit=1,file=aurora-vars.fd
```

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
   **Install Aurora OS** icon (shown in the live session when the installer app is part of the
   image), the taskbar and the Start menu. Signing out shows the Aurora sign-in screen.
4. In the VM, the screen switches to 1920x1080 (KVM) or 1600x900 (TCG) automatically; the
   network works out of the box (QEMU user networking, NAT).

Boot time: about 30–60 s to the desktop with KVM; several minutes under TCG.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Could not access KVM kernel module` / "KVM not available — using TCG" | enable VT-x/AMD-V in the PC's firmware; `sudo modprobe kvm_intel` (or `kvm_amd`); `sudo usermod -aG kvm $USER` and log in again; check `ls -l /dev/kvm` |
| Very slow boot | that is TCG (no KVM). Give it more cores (`CPUS=`), keep `MEM=4096`+, be patient on the first boot; the boot menu's default entry works, *copy to RAM* does not help under TCG |
| Black screen after the splash | choose **Safe graphics** in the boot menu; in QEMU try `make run VGA=std`; the *debug* entry logs everything to `work/qemu/aurora.serial.log` |
| Desktop does not appear, back to a sign-in screen | boot the *debug* entry and look for `aurora-session`/`aurora-shell` lines in the serial log; `journalctl -b -t aurora-session` in a text console (Ctrl+Alt+F1, user `aurora`, no password) |
| UEFI VM goes to the UEFI shell or does not find the ISO | Secure Boot firmware selected: use `OVMF_CODE_4M.fd` (`make run-uefi` does) |
| Installed VM does not boot | use the same firmware for installation and later boots (`make run-disk` for BIOS, `make run-disk-uefi` for UEFI) |
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
  (`sudo`) : la construction utilise `debootstrap`, `chroot`, des montages overlay et loop.
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

Voir le [tableau en anglais](#measured-build-time-and-size) (mêmes chiffres) : première
construction **MEASURE_COLD**, reconstruction sans changement de paquets **MEASURE_WARM**,
ISO de **MEASURE_ISO**.

### Vérifier l'image sans VM

`make smoke-image` monte le `filesystem.squashfs` de l'ISO en lecture seule, lance un Xvfb privé
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
est gardée dans `work/qemu/`. Utilisez le même mode (BIOS ou UEFI) pour installer et démarrer.

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
   **Installer Aurora OS** (présente en session live quand l'application d'installation fait partie
   de l'image), la barre des tâches et le menu Démarrer. Se déconnecter affiche l'écran de connexion.
4. Dans la VM, l'écran passe en 1920x1080 (KVM) ou 1600x900 (TCG) ; le réseau fonctionne
   directement (NAT de QEMU).

### Dépannage

| Problème | Solution |
|---|---|
| « KVM not available — using TCG » | activer VT-x/AMD-V dans le BIOS/UEFI du PC, `sudo modprobe kvm_intel` (ou `kvm_amd`), `sudo usermod -aG kvm $USER` puis se reconnecter |
| Démarrage très lent | c'est TCG (sans KVM) : plus de cœurs (`CPUS=`), `MEM=4096` ou plus, patience au premier démarrage |
| Écran noir après le logo | entrée **Mode graphique sûr** ; dans QEMU `make run VGA=std` ; l'entrée *débogage* journalise tout dans `work/qemu/aurora.serial.log` |
| Le bureau n'apparaît pas | entrée *débogage*, lignes `aurora-session`/`aurora-shell` du journal série ; `journalctl -b -t aurora-session` dans une console texte (Ctrl+Alt+F1, utilisateur `aurora`, sans mot de passe) |
| La VM UEFI tombe dans le shell UEFI | micrologiciel Secure Boot choisi : prendre `OVMF_CODE_4M.fd` (`make run-uefi` le fait) |
| La VM installée ne démarre pas | même micrologiciel pour l'installation et ensuite (`make run-disk` ou `make run-disk-uefi`) |
| Pas de son | `make run AUDIO=pa` ou `AUDIO=sdl` ; sous Ubuntu installer `qemu-system-gui` |
| Construction : `missing packages` | corriger le nom dans `iso/packages.d/*.list` (`apt-cache policy <nom>`) ou `ALLOW_MISSING_PACKAGES=1` |
| Construction : instantané injoignable | vérifier réseau/proxy ; `make iso SNAPSHOT=auto` ou `SNAPSHOT=0` |
| Construction : disque plein | libérer de la place (15 Go conseillés), `make clean` ; `cache/` peut aussi être supprimé |
| Montages restés après un plantage | `make clean` démonte tout ce qui se trouve sous `work/` |
