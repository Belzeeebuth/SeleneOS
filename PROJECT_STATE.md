# Selene OS — project state

> **Resuming work? Read this file first** and continue from "Next steps". Do not restart the
> project: everything below already exists on branch `claude/focused-lamport-ogvj6v`.
> Keep this file updated after every milestone.

_Last updated: 2026-10-12 01:30 UTC — visual redesign (Selene design system, 3 styles) nearly done: last tracks finishing, then strings pass, full test sweep and ISO rebuild._

## What this is

A desktop OS delivered as a bootable/installable ISO for QEMU. It started as a Windows 11-like desktop; since the
2026-10-11 redesign it has its own night-sky look (docs/design/BRIEF.md, docs/design/SYSTEM.md):
- **Base:** Ubuntu 24.04 (noble), pinned via snapshot.ubuntu.com.
- **Live session:** casper.
- **Login and session:** greetd → Electron login screen → Xorg → fullscreen Electron "Selene Shell", which draws the taskbar, the Launcher, windows and all apps.
- **Languages:** English and French everywhere.

**Decisions taken with the user:**
- Web-tech shell (Electron).
- Name "Selene OS".
- Renamed Aurora OS -> Selene OS on 2026-10-11 (visible branding; internal aurora-* names kept)
- Target QEMU first; `WITH_FIRMWARE=1` adds linux-firmware for real hardware.
- **QEMU testing:** the user tests in QEMU personally; since 2026-10-11 the agent may also boot it headless here
  (`make run HEADLESS=1`, TCG) to debug boot problems.
- **Do not send screenshots** unless the user asks.
- **Arch Linux variant:** discussed and deferred. A possible later `make iso-arch` (archiso profile), but Arch mirrors are blocked in the build container.

## Current phase

| Phase | Status |
|---|---|
| 1. Questions | done |
| 2. Architecture | done (docs/DEVELOPING.md) |
| 3. Core ISO + desktop | done — ISO ≈ 806 MB, `make verify-iso` 118/118, `make smoke-image` passes; live desktop boots in QEMU (checked headless under TCG, 2026-10-11) |
| 4. Required apps | done — browser, files, mail, paint, calculator, notepad, terminal, media, snipping, taskmgr, settings, 5 games |
| 5. Installer + QEMU instructions | done — installer app + aurora-install helper; docs/BUILDING.md (EN + FR) |
| UI/UX personalization (user request #2) | **done** — see docs/PERSONALIZATION.md |
| App phase 1 (PHASEAPP.md) | **done** — photos, calendar, clock, notes, todo, pdf, archive |
| App phase 3 (PHASEAPP.md) | **done** — store, disks, backup, passwords, cloud (light), nettools (light) |
| App phase 4 (PHASEAPP.md) | **done** — weather, maps, contacts, sticky, translate, remote (VNC) |
| Linux GUI apps (external X11 windows) | **done** — aurora-xwm helper (python3-xlib) + shaped shell window + frames, .desktop entries in Start/search, 12 GUI apps in the Store; see docs/XWINDOWS.md |
| Store sources (Flathub + Ubuntu AppStream) | **done** — per-user Flatpak installs from Flathub (no root), full Ubuntu desktop-app catalogue from DEP-11 (apt installs through aurora-admin, verified against root-owned DEP-11 lists; image packages never removable); merged catalogue UI; see docs/STORE-SOURCES.md |
| Visual redesign (user request, 2026-10-11) | **nearly done** — brief in docs/design/BRIEF.md (all user answers), system in docs/design/SYSTEM.md; styles Nocturne (default) / Éclipse / Clair de lune / Contraste élevé × ambiances × accents; Phosphor icons, Manrope + Inter, new app icons, wallpapers, logo, GRUB/Plymouth; Windows names replaced (Lanceur, Fichiers, Moniteur système…); bar icons centred in every style |
| App phase 2 | not started — wait for the user's go; run it like phases 3–4 (one workflow per app, all in parallel) |

### App / area status (every area has its own test suite in shell/test/)

| Area | Checks in the last full run |
|---|---|
| Shell UX, window management, login/lock, Settings | shell-ux 375, wm-nav 241, login-lock 302, system-settings 158 |
| Browser, Files, Mail | browser 67 tests, files 274, mail 44 |
| Paint, Calculator, Notepad, Terminal, Media, Snipping, Task Manager, Installer | paint 51 tests, calculator 672, notepad 289, terminal 246, media 48, snipping 40, taskmgr 173, installer 161 |
| Games | games-classic 85, solitaire 72, chess 68 |
| Phase 1 apps | photos 46, pdf 244, archive 468, notes 262 + 156 unit, calendar 378 + 131 unit, clock 448, todo 361 |
| Personalization | personalization-core 144, personalization-shell 90, taskbar-start-focus 269, packs-input 148, wallpapers 300 |
| Core | smoke, core-dialogs 6 |
| Linux GUI apps + Store sources | xwm-helper 78, xwin 63 (incl. real xterm end-to-end), xapps 71, store 128, store-flathub 83, store-ubuntu 84 |

Last full sweep (2026-10-11): 34/34 suites green; wallpapers and wm-nav needed one retry on the loaded 4-CPU build machine (timing only).

## File structure

```
aurora-os/
  README.md  PHASEAPP.md  PROJECT_STATE.md  Makefile
  docs/BUILDING.md        build, QEMU run/install instructions (EN + FR)
  docs/DEVELOPING.md      architecture, app contract, UI kit, backend API (all channels), app list
  docs/PERSONALIZATION.md settings schema and behaviour of every personalization feature
  docs/design/            redesign brief (user answers), design system, mockups, previews
  docs/screenshots/       test screenshots
  iso/config.sh build.sh Dockerfile packages.d/*.list   ISO build (debootstrap → squashfs → grub-mkrescue)
  rootfs/                 overlay copied into the image (session scripts, greetd, polkit, sudoers, helpers)
    usr/lib/aurora/helpers/  aurora-admin (allow-listed root actions), aurora-install, aurora-pty,
                             aurora-checkpass (PAM), aurora-apply-display
  tools/qemu-run.sh qmp.py   QEMU launcher (KVM/TCG, BIOS/UEFI, --dry-run) and QMP helper
  shell/                  Electron app
    main/index.js         modes: --mode=shell | --mode=greeter ; --dev for windowed dev
    main/lib/             ipc framework, app:// + media:// protocols, hotkeys, exec/sudo helpers
    main/ipc/*.js         one backend module per area (fs, sys, settings, net, audio, display, users,
                          admin, locale, greetd, auth, browser, mail, pty, taskmgr, installer, …)
    preload/preload.js    window.aurora bridge
    renderer/shell.html greeter.html
    renderer/core/        wm, taskbar, start, desktop, ui kit, i18n, theme, settings, notify, sounds,
                          registry, services (ctx.shell), reminders (shared alarms), greeter/, features/*
    renderer/apps/<id>/   manifest.json main.js style.css i18n.json icon.svg (+ app modules)
    renderer/assets/      Phosphor icons (phosphor.json + aliases.json), fonts (Manrope, Inter), wallpapers, logos
    test/lib.mjs smoke.mjs <area>.test.mjs   Playwright-driven Electron tests (run under xvfb)
    test/run-all.mjs      runs every suite (make test-all)
```

## Commands

```sh
sudo make iso                      # build out/selene-os-<ver>-amd64.iso (needs root, Node 22, build tools)
sudo ./iso/build.sh --from system  # fast rebuild when only the shell/rootfs changed (package layer cached)
make run | run-uefi | run-disk     # QEMU (the user tests these; the agent uses DRY_RUN=1 only)
make verify-iso                    # static ISO checks (no VM)
make smoke-image                   # run the image's shell + greeter under Xvfb (no VM)
make test-all                      # every shell test suite (TEST_ARGS="-j 3 --retry --only=files,mail")
cd shell && npm ci && npx electron . --dev --no-sandbox      # dev desktop
cd shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/<area>.test.mjs
```

## Shared contracts

- **`shell.reminders`** (core/reminders.js): shared alarm/reminder scheduler (Calendar, Clock, To Do).
- **Manifest `defaultFor`:** extensions an app opens by default (Photos for images, PDF Reader for `.pdf`).
- **`trustedDragPaths(dataTransfer)`** (core/desktop.js): the only way to read `application/x-aurora-paths` from a drop.
- **`shell.runAdmin`** rejects with `ECANCELED` (prompt dismissed) or `ENOTADMIN` (standard account).
- **`ui.dialog`** settles with `null` when its parent window closes; `win.setMinSize`, `win.setAlwaysOnTop`, `win.closed`.
- **Personalization:** settings keys and profile keys are documented in docs/PERSONALIZATION.md; `i18n.extend()` for core strings.

## Known issues / limitations

- Sounds were never heard (no audio device in the build container).
- Boot fixes (2026-10-11, after the user saw a black screen after the splash in QEMU):
  - Plymouth used to quit with `--retain-splash`, which left tty1 in graphics mode, so greetd's switch to vt7 was refused.
    The override is gone; verify-iso rejects it.
  - virtio-vga without virgl was taken for a 3D GPU (the card's device is the PCI function, driver `virtio-pci`), so
    Electron's GPU process crashed (exit 133). `aurora_gpu_mode` now reads the `virtioN` child's feature bits, and
    aurora-xsession retries the shell with `AURORA_GPU=off` after a crash with the GPU on.
  - Under TCG, QEMU's emulated AVX2 gather (`vpgatherdd`) faults on masked-off lanes and Skia's software renderer
    crashed the GPU process ("GPU process isn't usable"). qemu-run.sh uses `-cpu max,avx2=off` for TCG (KVM: `-cpu host`).
  - Fluidity: without 3D in the VM everything is drawn by the CPU (the user saw it on a laptop on battery). `make run`
    now defaults to `VGA=auto`: virgl (`virtio-gl`) when the host has a render node, QEMU's virtio-vga-gl and the OpenGL
    display, with a restart without 3D if QEMU refuses it at startup. The user confirmed virtio-gl is much smoother.
  - GRUB theme: PNGs must be 8-bit RGB/RGBA (GRUB drew rainbow rings otherwise) and theme fonts must match the .pf2
    names; verify-iso checks both.
- Build chroot /dev (fixed 2026-10-11): the packages stage used to bind the host's /dev, and systemd-tmpfiles'
  static-nodes-permissions.conf in the chroot chown'd the HOST's /dev/kvm to the image's kvm GID (994) 0660, so the
  user lost KVM after every packages stage. build.sh now gives the chroot a private tmpfs /dev (mount_private_dev).
  Recovery on the host: `sudo udevadm trigger --action=add --sysname-match=kvm` (or reboot).
- Linux GUI apps checked in the real ISO under QEMU (2026-10-11): aurora-xwm starts with the shell ("helper ready"),
  an xmessage window shows inside a Selene frame with taskbar entry.
- The user builds on an Arch-like host with fish (heredocs fail; use `bash` first) and `sudo make docker-iso`.
- Browser: pop-ups open as tabs (`window.opener` missing); real sites blocked by the build container's proxy.
- Mail: no OAuth2; passwords are obfuscated, not encrypted (no keyring).
- Wi-Fi key passed on the `nmcli` command line (briefly visible in /proc to other local users).
- fs.js: `fs:readText` throws ETOOBIG instead of returning the first bytes; `fs:copy` has no cancel.
- Alt+F4 while a dialog is open inside a window does nothing (Windows closes the dialog); no per-window Tab containment in wm.
- Tasks reminders have no "Mark as completed" button (shell.reminders has no app buttons yet).
- Cursor packs don't apply inside web pages; Busy/Working cursors are static.
- Some tests are timing-sensitive on a loaded 4-CPU machine; `make test-all --retry` separates those from real failures.
- ISO not bit-for-bit reproducible (grub-mkrescue date + volume UUID).
- Linux GUI apps (first version, docs/XWINDOWS.md): no live thumbnails of X windows in Alt+Tab / Overview (app icon
  instead); no hole while a frame animates; max-size hints not enforced; modal X dialogs don't block their parent;
  no Alt+drag move; Firefox/Chromium/Thunderbird are snaps on noble (not offered; Mozilla's APT repo would be needed).
  Store installs use --no-install-recommends (LibreOffice without libreoffice-gtk3 uses its plain X11 look).
- Store sources (first version): Flathub could not be reached from the build container (proxy 403), so Flathub was
  developed against a fixture catalogue; the real `flatpak remote-add/update --appstream/install` runs only in the VM.
  No Updates page yet, no install cancel, Flatpak runtimes are big (live session keeps them in RAM).
- Build host leftovers: empty /cdrom and /usr/lib/aurora (harmless).

## Next steps (exact)

1. Wait for the user's QEMU feedback on the Selene OS ISO (phases 3 + 4 apps, rename, new logo).
2. Open questions from the user: Snake arrow keys reported as not working (works in the agent's VM with real
   key events: likely host/QEMU keyboard side; asked the user whether Space works and whether arrows work elsewhere).
3. App **Phase 2** when the user asks: same mode as phases 3–4 (one workflow per app, all 6 in parallel, builder +
   8-min checker, lean tests, max 2 screenshots), ~45 min.
4. Known follow-ups (small): Memos does not tell the user when it restored notes from a backup; Cloud real
   client ignores back-pressure and shows 100 % for chunked downloads; Remote Desktop scaled canvas is blurry
   (image-rendering); Translator MyMemory limit is bytes not characters; weather:current still makes a real request
   in dev (wallpapers test expects it).

## Personalization request (verbatim, user request #2)

- Theme designer: custom accent color, wallpaper, lock screen, taskbar color, window transparency and blur intensity.
- Visual styles: Nocturne (default), Éclipse, Clair de lune, high contrast.
- Animated wallpapers and dynamic wallpapers that change with time of day or weather.
- Customizable taskbar: size, position, icons, indicators, transparency, auto-hide.
- Custom Launcher: layout, pinned apps, folders, recommended files, background style.
- Cursor packs, icon packs, sound packs, notification sounds, and startup/shutdown sounds.
- Font and text size controls, rounded-corner intensity, UI scale, and reduced-motion mode.
- Per-app themes: light, dark, system, or custom accent.
- Layout presets and customizable keyboard shortcuts.
- Optional "Focus": hides notifications, dims desktop, and simplifies the taskbar.
- Profile system: save and switch between complete UI themes with one click.

## History (short)

- 2026-10-10 16:10 UTC: project start (phases 1–5, then personalization and app phase 1 requests).
- Two usage-limit interruptions (session limit ~23:00 UTC, weekly limit ~02:00 UTC); work resumed from this file.
- 2026-10-11 ~08:00 UTC: the user asked to cut the remaining time; the plan was restructured (parallel verify agents,
  no duplicated regression sweeps, ISO package layer pre-built, `make test-all`). Finished ~09:30 UTC.
