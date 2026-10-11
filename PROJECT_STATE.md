# Aurora OS — project state

> **Resuming work? Read this file first** and continue from "Next steps". Do not restart the
> project: everything below already exists on branch `claude/focused-lamport-ogvj6v`.
> Keep this file updated after every milestone.

_Last updated: 2026-10-11 09:20 UTC — app phase 1 and UI/UX personalization done; final checks below._

## What this is

A Windows 11-like desktop OS delivered as a bootable/installable ISO for QEMU:
- **Base:** Ubuntu 24.04 (noble), pinned via snapshot.ubuntu.com.
- **Live session:** casper.
- **Login and session:** greetd → Electron login screen → Xorg → fullscreen Electron "Aurora Shell", which draws the taskbar, Start menu, windows and all apps.
- **Languages:** English and French everywhere.

**Decisions taken with the user:**
- Web-tech shell (Electron).
- Name "Aurora OS".
- Target QEMU first; `WITH_FIRMWARE=1` adds linux-firmware for real hardware.
- **No QEMU testing by the agent:** the user tests in QEMU personally.
- **Do not send screenshots** unless the user asks.
- **Arch Linux variant:** discussed and deferred. A possible later `make iso-arch` (archiso profile), but Arch mirrors are blocked in the build container.

## Current phase

| Phase | Status |
|---|---|
| 1. Questions | done |
| 2. Architecture | done (docs/DEVELOPING.md) |
| 3. Core ISO + desktop | done — ISO ≈ 818 MB, `make verify-iso` 114/114; QEMU boot left to the user |
| 4. Required apps | done — browser, files, mail, paint, calculator, notepad, terminal, media, snipping, taskmgr, settings, 5 games |
| 5. Installer + QEMU instructions | done — installer app + aurora-install helper; docs/BUILDING.md (EN + FR) |
| UI/UX personalization (user request #2) | **done** — see docs/PERSONALIZATION.md |
| App phase 1 (PHASEAPP.md) | **done** — photos, calendar, clock, notes, todo, pdf, archive |
| App phases 2–4 | not started — wait for the user's go (see "Next steps") |

### App / area status (every area has its own test suite in shell/test/)

| Area | Checks in the last full run |
|---|---|
| Shell UX, window management, login/lock, Settings | shell-ux 375, wm-nav 241, login-lock 302, system-settings 157 |
| Browser, Files, Mail | browser 67 tests, files 274, mail 44 |
| Paint, Calculator, Notepad, Terminal, Media, Snipping, Task Manager, Installer | paint 51 tests, calculator 672, notepad 289, terminal 245, media 48, snipping 40, taskmgr 173, installer 161 |
| Games | games-classic 85, solitaire 72, chess 68 |
| Phase 1 apps | photos 46, pdf 244, archive 468, notes 262 + 156 unit, calendar 378 + 131 unit, clock 448, todo 361 |
| Personalization | personalization-core 144, personalization-shell 90, taskbar-start-focus 269, packs-input 148, wallpapers 300 |
| Core | smoke, core-dialogs 6 |

## File structure

```
aurora-os/
  README.md  PHASEAPP.md  PROJECT_STATE.md  Makefile
  docs/BUILDING.md        build, QEMU run/install instructions (EN + FR)
  docs/DEVELOPING.md      architecture, app contract, UI kit, backend API (all channels), app list
  docs/PERSONALIZATION.md settings schema and behaviour of every personalization feature
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
    renderer/assets/      Fluent icons (fluent.json), wallpapers, logos
    test/lib.mjs smoke.mjs <area>.test.mjs   Playwright-driven Electron tests (run under xvfb)
    test/run-all.mjs      runs every suite (make test-all)
```

## Commands

```sh
sudo make iso                      # build out/aurora-os-<ver>-amd64.iso (needs root, Node 22, build tools)
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

- QEMU boot of the latest ISO is untested by the agent (user's choice). Sounds were never heard (no audio device).
- Browser: pop-ups open as tabs (`window.opener` missing); real sites blocked by the build container's proxy.
- Mail: no OAuth2; passwords are obfuscated, not encrypted (no keyring).
- Wi-Fi key passed on the `nmcli` command line (briefly visible in /proc to other local users).
- fs.js: `fs:readText` throws ETOOBIG instead of returning the first bytes; `fs:copy` has no cancel.
- Alt+F4 while a dialog is open inside a window does nothing (Windows closes the dialog); no per-window Tab containment in wm.
- To Do reminders have no "Mark as completed" button (shell.reminders has no app buttons yet).
- Cursor packs don't apply inside web pages; Busy/Working cursors are static.
- Some tests are timing-sensitive on a loaded 4-CPU machine; `make test-all --retry` separates those from real failures.
- ISO not bit-for-bit reproducible (grub-mkrescue date + volume UUID).
- Build host leftovers: empty /cdrom and /usr/lib/aurora (harmless).

## Next steps (exact)

1. Wait for the user. They test the ISO in QEMU themselves (never run QEMU; no screenshots unless asked).
2. App **Phase 2** (PHASEAPP.md) only when the user asks.
   **Mode (user decision, 2026-10-11):** extra usage on, ultracode OFF. Lean: one builder + one verifier per app,
   2 apps at a time, time box per agent, key screenshots only, one `make test-all` at the end; small fixes done
   directly without agents.

## Personalization request (verbatim, user request #2)

- Theme designer: custom accent color, wallpaper, lock screen, taskbar color, window transparency and blur intensity.
- Multiple visual styles: Windows 11-like, minimal, glassmorphism, retro, high contrast.
- Animated wallpapers and dynamic wallpapers that change with time of day or weather.
- Customizable taskbar: size, position, icons, widgets, transparency, auto-hide.
- Custom Start menu: layout, pinned apps, folders, recommended files, background style.
- Cursor packs, icon packs, sound packs, notification sounds, and startup/shutdown sounds.
- Font and text size controls, rounded-corner intensity, UI scale, and reduced-motion mode.
- Per-app themes: light, dark, system, or custom accent.
- Snap layout presets and customizable keyboard shortcuts.
- Optional "Focus mode": hides notifications, dims desktop, and simplifies the taskbar.
- Profile system: save and switch between complete UI themes with one click.

## History (short)

- 2026-10-10 16:10 UTC: project start (phases 1–5, then personalization and app phase 1 requests).
- Two usage-limit interruptions (session limit ~23:00 UTC, weekly limit ~02:00 UTC); work resumed from this file.
- 2026-10-11 ~08:00 UTC: the user asked to cut the remaining time; the plan was restructured (parallel verify agents,
  no duplicated regression sweeps, ISO package layer pre-built, `make test-all`). Finished ~09:30 UTC.
