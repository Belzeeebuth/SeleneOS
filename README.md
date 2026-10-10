# Aurora OS

A Windows 11–style desktop operating system you can boot live from an ISO and install in a virtual
machine. It is built on **Ubuntu 24.04 LTS**, with a fully custom desktop: the shell, the window
manager, the login screen and every app are written from scratch for Aurora. Everything is
available in **English and French**, in light and dark themes.

![Aurora desktop](docs/screenshots/shell-desktop.png)

## Features

**Desktop**
- Centered taskbar (or left-aligned), Start menu with pinned apps, all apps and recommended files
- Search, quick settings (Wi-Fi, volume, dark mode, night light, do not disturb), calendar and
  notification center, widgets
- Window manager drawn by the shell itself: open/close/minimize/maximize animations, edge snapping,
  Snap layouts, Snap assist, Alt+Tab, Task View with virtual desktops
- Windows 11-like visuals: Mica windows, acrylic blur, accent colors, original wallpapers, light/dark mode
- Keyboard shortcuts: Win, Win+D/E/I/L/A/N/S/R/X, Win+Tab, Win+arrows, Alt+Tab, Alt+F4,
  Ctrl+Shift+Esc, Ctrl+Alt+Del, PrintScreen / Win+Shift+S
- Login screen and lock screen with PAM authentication, "User Account Control" prompts for admin
  actions, firewall (ufw) enabled by default

**Apps**

| App | Highlights |
|---|---|
| Aurora Browser | Chromium engine, tabs, bookmarks bar and manager, history, downloads, private windows, find, zoom |
| File Explorer | Tabs, breadcrumb bar, copy/cut/paste, rename, delete to Recycle Bin, search, drives (mount/eject), properties |
| Mail | IMAP/SMTP accounts with provider presets (Gmail, Outlook, Yahoo, iCloud, Orange, Free…), compose, attachments, webmail shortcut |
| Paint | Brushes, shapes, fill, text, eraser, color picker, selection, undo/redo, PNG/JPEG/BMP/WebP save |
| Calculator | Standard, Scientific, Programmer, date calculation and unit converters, history and memory |
| Notepad | Tabs, find/replace, go to line, word wrap, encodings and line endings |
| Terminal | Real PTY with Bash, tabs, split panes, color schemes |
| Media Player | Music and video libraries, queue, playlists, audio visualizer, sample media included |
| Snipping Tool | Rectangle/window/full-screen/free-form captures, markup, save and copy |
| Task Manager | Processes with heat map, live performance graphs, users, details, services |
| Settings | System, network, personalization, apps, accounts, time & language, accessibility, privacy & security, updates |
| Games | Minesweeper, Solitaire, Snake, 2048, Chess (with a computer opponent) |
| Installer | Windows Setup–style installer: language, keyboard, disk, account, time zone |

## Quick start

You need a Linux host (Ubuntu or Debian recommended) with root access, about **25 GB** of free disk
space and **Node.js 22**. Full details are in [docs/BUILDING.md](docs/BUILDING.md).

```sh
# 1. Build tools
sudo apt-get install debootstrap ubuntu-keyring squashfs-tools xorriso mtools dosfstools \
     grub-common grub-pc-bin grub-efi-amd64-bin librsvg2-bin imagemagick unzip curl zstd git

# 2. Build the ISO  ->  out/aurora-os-<version>-amd64.iso
cd aurora-os
sudo make iso

# 3. Try it in QEMU
sudo apt install qemu-system-x86 qemu-system-gui qemu-utils ovmf
make run          # BIOS firmware, live session + a 32 GB virtual disk to install to
make run-uefi     # same with UEFI firmware
```

No Ubuntu host? `make docker-iso` builds the ISO inside a privileged `ubuntu:24.04` container.

Use KVM for speed (`/dev/kvm` must be accessible: `sudo usermod -aG kvm $USER`). Without KVM, QEMU
still works, but the first boot takes several minutes.

Without the Makefile, this plain QEMU command does the same job (`make run DRY_RUN=1` prints the
exact command it uses):

```sh
qemu-img create -f qcow2 aurora-disk.qcow2 32G
qemu-system-x86_64 -enable-kvm -machine q35 -cpu host -m 4096 -smp 4 \
  -drive file=aurora-disk.qcow2,if=none,id=hd0,format=qcow2 -device virtio-blk-pci,drive=hd0,bootindex=1 \
  -drive file=out/aurora-os-1.0.0-amd64.iso,if=none,id=cd0,media=cdrom,readonly=on -device ide-cd,drive=cd0,bootindex=2 \
  -vga none -device virtio-vga -device qemu-xhci -device usb-tablet \
  -nic user,model=virtio-net-pci \
  -audiodev pipewire,id=snd0 -device intel-hda -device hda-duplex,audiodev=snd0
```

The disk boots first. While it is still blank, the firmware falls through to the ISO; after
installation, the installed system starts even with the ISO attached.

## Installing in QEMU

1. Run `make run` and pick **Aurora OS (English)** or **Aurora OS (Français)** in the boot menu.
2. The live session signs in automatically. Open **Install Aurora OS** from the desktop.
3. Choose language, keyboard, the virtual disk (it will be **erased**), your account and time zone,
   then click **Install**.
4. When it finishes, click **Restart now**. `make run` boots the installed disk first, so the ISO
   can stay attached. To boot only the disk later, use `make run-disk` (or `make run-disk-uefi`).
5. Sign in with the account you created.

## Project layout

```
aurora-os/
  shell/      Electron app: desktop shell, login screen and all built-in apps
  rootfs/     files copied into the OS image (session scripts, helpers, configs)
  iso/        ISO build scripts (debootstrap -> squashfs -> hybrid BIOS/UEFI ISO)
  tools/      QEMU launcher and helpers
  docs/       BUILDING.md (build, run, install), DEVELOPING.md (architecture, app API)
```

**Architecture:**
- Ubuntu 24.04 base (pinned archive snapshot for reproducible builds) with casper for the live session.
- greetd starts the Aurora login screen. After sign-in, Xorg runs the fullscreen Electron shell, which
  draws the taskbar, the Start menu and every window.
- System features use standard Linux services: NetworkManager, PipeWire, udisks2, systemd-logind and
  ufw.

## Development

```sh
cd aurora-os/shell
npm ci
npx electron . --dev --no-sandbox               # run the desktop in a window
npx electron . --dev --no-sandbox --mode=greeter  # run the login screen
xvfb-run -a -s "-screen 0 1600x900x24" node test/smoke.mjs
```

Each app has its own Playwright test in `shell/test/`. See [docs/DEVELOPING.md](docs/DEVELOPING.md)
for the app contract, the UI kit and the backend API.

## License

The Aurora shell, apps, scripts and artwork are released under the MIT license. Icons come from
Microsoft's Fluent UI System Icons (MIT). The base system is Ubuntu, and its components keep their
own licenses. Aurora OS is not affiliated with Microsoft. "Windows" is a trademark of Microsoft
Corporation.
