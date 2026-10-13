# Selene OS

A desktop operating system you can boot live from an ISO and install in a virtual machine. It is
built on **Ubuntu 24.04 LTS**, with a fully custom desktop: the shell, the window manager, the login
screen and every app are written from scratch for Selene OS, with a night-sky look of their own.
Everything is available in **English and French**, dark by default, with a light mode.

![Selene OS desktop](docs/screenshots/shell-desktop.png)

## Features

**Desktop**
- Bar with centred app icons, Launcher with pinned apps, all apps and recommended files
- Search, Quick settings (Wi-Fi, volume, dark mode, night light, do not disturb), calendar,
  notifications drawer, Dashboard
- Window manager drawn by the shell itself: open/close/minimize/maximize animations, edge snapping,
  Layouts, Snap assist, Alt+Tab, Overview with virtual desktops
- Selene design: three styles (Nocturne, Éclipse, Clair de lune) plus High contrast, cold / neutral / warm
  ambiances, four accents (silver, night blue, violet, amber), Manrope and Inter fonts, Phosphor icons,
  app icons on a common night-blue base, original wallpapers ([docs/design/SYSTEM.md](docs/design/SYSTEM.md))
- Keyboard shortcuts: Super, Super+D/E/I/L/A/N/S/R/X, Super+Tab, Super+arrows, Alt+Tab, Alt+F4,
  Ctrl+Shift+Esc, Ctrl+Alt+Del, PrintScreen / Super+Shift+S
- Regular Linux applications (GIMP, LibreOffice, VLC, Inkscape…) open in Selene windows with bar entries, Alt+Tab,
  snapping and the light/dark theme; installed programs appear in the Launcher and search ([docs/XWINDOWS.md](docs/XWINDOWS.md))
- Login screen and lock screen with PAM authentication, "Administrator permission" prompts for admin
  actions, firewall (ufw) enabled by default
- Bluetooth pairing (headsets, mice, keyboards, phones, gamepads), printers (driverless IPP Everywhere) with a print
  dialog in the apps, app and firmware updates (Flathub, fwupd), Orca screen reader (Super+Alt+S)
- Optional NVIDIA driver and gaming apps (Steam, Heroic, Lutris…) offered by the installer
- Ready for real PCs: hardware firmware included, boots with Secure Boot, recent (HWE) kernel, touchpad and power
  settings (screen off, sleep, lid, power modes, battery alerts), automatic security updates
- Linux and Flatpak apps fit in: their notifications, tray icons and startup entries, links and files they open land in
  Selene apps, spell check in French and English, screen sharing in the browser
- Selene updates itself like the rest of the system (signed apt repository, see [docs/UPDATES.md](docs/UPDATES.md));
  crash recovery, safe mode and a diagnostic report

**Personalization** (details in [docs/PERSONALIZATION.md](docs/PERSONALIZATION.md))
- Theme designer: style, ambiance, accent color, wallpaper, lock screen, bar color, window transparency and blur intensity;
  font, text size, rounded corners, UI scale and reduced motion
- Four visual styles (Nocturne, Éclipse, Clair de lune, High contrast) and per-app light / dark / accent themes
- Animated wallpapers, and dynamic wallpapers that follow the time of day and the weather; slideshow
- Bar (size, position, icons, indicators, transparency, auto-hide) and Launcher (layouts, pinned apps,
  folders, recommended files, background style)
- Cursor, icon and sound packs, with custom notification, startup and shutdown sounds
- Custom layouts and fully customizable keyboard shortcuts
- Focus: hides notifications, dims the desktop and simplifies the bar, with a session timer
- Profiles: save the whole look and switch themes in one click; export and import

**Apps**

| App | Highlights |
|---|---|
| Browser | Chromium engine, tabs, bookmarks bar and manager, history, downloads, private windows, find, zoom |
| Files | Home page with folders, recent files and favourites; tabs, breadcrumb, copy/cut/paste, rename, Trash, search, drives (mount/eject), properties |
| Mail | IMAP/SMTP accounts with provider presets (Gmail, Outlook, Yahoo, iCloud, Orange, Free…), compose, attachments, webmail shortcut |
| Draw | Brushes, shapes, fill, text, eraser, color picker, selection, undo/redo, PNG/JPEG/BMP/WebP save |
| Calculator | Standard, Scientific, Programmer, date calculation and unit converters, history and memory |
| Text Editor | Tabs, find/replace, go to line, word wrap, encodings and line endings |
| Terminal | Real PTY with Bash, tabs, split panes, color schemes |
| Code Editor | Folder explorer with git status (.gitignore-aware), tabs, syntax highlighting (CodeMirror 6: JS/TS, Python, HTML/CSS, JSON, Markdown, C/C++, Rust, Go, shell, YAML, TOML), find/replace with regex, go to line, multi-cursor, built-in terminal, branch in the status bar |
| Player | Music and video libraries, queue, playlists, audio visualizer, sample media included |
| Music | Lanceur entry (alias of the Player) that opens its music library: albums with covers (embedded art or folder.jpg), artists, songs, synced lyrics from .lrc files or embedded lyrics |
| Photos | Gallery by date, folders, favorites and albums; viewer with zoom and filmstrip, slideshow; editor with crop, straighten, adjustments and filters |
| Camera | Webcam photos and videos (WebM with sound), 3 / 10 s timer, grid, mirrored preview, camera and resolution choice; saved to Pictures/Camera Roll |
| Voice Recorder | One-button recording with pause, markers and a live waveform, microphone choice and level, playback with a seekable waveform, trim (copy or replace), rename, share in Files, MP3 / M4A export (ffmpeg); Opus/WebM in Documents/Sound recordings |
| PDF Reader | Tabs, page thumbnails and outline, find, zoom and page layouts, highlight and draw, presentation mode |
| Archives | Browse, extract and create ZIP, 7z, RAR and TAR archives, password-protected archives, test and preview |
| Notes | Notebooks, rich text, checklists, pictures and tags, Markdown import/export, saved as you type |
| Calendar | Day, work week, week, month and agenda views, recurring events, reminders, holidays, .ics import/export |
| Clock | Alarms, timers, stopwatch, world clock and focus sessions; alarms ring even when the app is closed |
| Tasks | Lists, My Day, reminders, due dates, repeats and steps |
| Screenshot | Rectangle/window/full-screen/free-form captures, markup, save and copy |
| Screen Recorder | Whole screen or a drawn area, microphone and computer sound, 3-2-1 countdown, floating pause / stop control kept out of the video, red bar indicator, Super+Shift+R; WebM (or MP4 through ffmpeg) in Videos/Screen recordings |
| System Monitor | Processes with heat map, live performance graphs, users, details, services |
| Settings | System, network, Bluetooth, printers, personalization, apps, accounts, time & language, accessibility (screen reader), privacy & security, updates (system and firmware), graphics drivers |
| Weather | Current conditions, 24-hour and 7-day forecasts, saved places; sets the dynamic wallpaper location |
| Maps | OpenStreetMap maps, place search, saved places |
| Contacts | People, e-mails, phones, addresses, birthdays, vCard import/export; suggestions in Mail |
| Memos | Colourful notes that can stay on top, saved as you type, copy to Notes |
| Translator | Seven languages (MyMemory or your LibreTranslate server), English dictionary, offline EN↔FR glossary |
| Remote Desktop | VNC client (RDP later) |
| Software | The whole Flathub catalogue (Firefox, Chromium, Spotify, Discord, Steam, Blender…) with an Updates view and every desktop app of the Ubuntu archive, with icons, search, categories and screenshots; plus curated tools and services ([docs/STORE-SOURCES.md](docs/STORE-SOURCES.md)) |
| Disks | Drives and partitions, mount and eject, format USB sticks and SD cards |
| Backup | Incremental snapshots of your folders to a drive; browse and restore |
| Passwords | Encrypted password vault with a generator |
| Cloud | Nextcloud / WebDAV files: browse, upload, download |
| Network tools | VPN and WireGuard connections, ping, DNS lookup |
| Games | Minesweeper, Solitaire, Snake, 2048, Chess (with a computer opponent) |
| Installer | Language, keyboard, disk, account, time zone, NVIDIA driver, gaming apps |

## Quick start

You need a Linux host (Ubuntu or Debian recommended) with root access, about **25 GB** of free disk
space and **Node.js 22**. Full details are in [docs/BUILDING.md](docs/BUILDING.md).

```sh
# 1. Build tools
sudo apt-get install debootstrap ubuntu-keyring squashfs-tools xorriso mtools dosfstools \
     grub-common grub-pc-bin grub-efi-amd64-bin librsvg2-bin imagemagick unzip curl zstd git

# 2. Build the ISO  ->  out/selene-os-<version>-amd64.iso
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
  -drive file=out/selene-os-1.0.0-amd64.iso,if=none,id=cd0,media=cdrom,readonly=on -device ide-cd,drive=cd0,bootindex=2 \
  -vga none -device virtio-vga -device qemu-xhci -device usb-tablet \
  -nic user,model=virtio-net-pci \
  -audiodev pipewire,id=snd0 -device intel-hda -device hda-duplex,audiodev=snd0
```

The disk boots first. While it is still blank, the firmware falls through to the ISO; after
installation, the installed system starts even with the ISO attached.

## Installing in QEMU

**System requirements:** 64-bit PC or VM, **4 GB of RAM recommended** (the installer warns below that but does not
stop you; with less, the desktop gets slow once several apps are open), 12 GB of disk at least.

1. Run `make run` and pick **Selene OS (English)** or **Selene OS (Français)** in the boot menu.
2. The live session signs in automatically. Open **Install Selene OS** from the desktop.
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
  docs/       BUILDING.md (build, run, install), DEVELOPING.md (architecture, app API),
              PERSONALIZATION.md (themes, styles, wallpapers, bar, packs, profiles),
              design/ (redesign brief, design system, mockups)
```

**Architecture:**
- Ubuntu 24.04 base (pinned archive snapshot for reproducible builds) with casper for the live session.
- greetd starts the Selene login screen. After sign-in, Xorg runs the fullscreen Electron shell, which
  draws the bar, the Launcher and every window.
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

The Selene shell, apps, scripts and artwork are released under the MIT license. Interface icons come
from Phosphor Icons (MIT); the Manrope and Inter fonts are under the SIL Open Font License. The base
system is Ubuntu, and its components keep their own licenses.
