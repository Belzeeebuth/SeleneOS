# Selene OS — project state

> **Resuming work? Read this file first** and continue from "Next steps". Do not restart the
> project: everything below already exists on branch `claude/focused-lamport-ogvj6v`.
> Keep this file updated after every milestone.

_Last updated: 2026-10-14 evening — the six « later » items stopped half-way were finished and tested (Éditeur de code search / split / diff, Disques SMART, Outils réseau OpenVPN / traceroute / ports / speed test, Cartes routes, Bureau à distance RDP + VNC clipboard / encodings, Lecteur MPRIS + media keys); the 19 suites they touch passed together (17 min). Tests now run with --mute-audio. Earlier the same day: app phase 5, Mémos / Traducteur removed, docs reviewed, dual boot validated in QEMU/KVM. Previous ISO: 2026-10-13 18:00 (verify-iso 292 checks, 0 failures)._

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
- **Dropped by the user:** Video Editor (2026-10-13); Mémos (`sticky`), Traducteur (`translate`), Google Drive / OneDrive in
  Cloud, password autofill in the Navigateur (2026-10-14).
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
| App phase 4 (PHASEAPP.md) | **done** — weather, maps, contacts, remote (VNC); sticky and translate were removed on 2026-10-14 at the user's request |
| Linux GUI apps (external X11 windows) | **done** — aurora-xwm helper (python3-xlib) + shaped shell window + frames, .desktop entries in Start/search, 12 GUI apps in the Store; see docs/XWINDOWS.md |
| Store sources (Flathub + Ubuntu AppStream) | **done** — per-user Flatpak installs from Flathub (no root), full Ubuntu desktop-app catalogue from DEP-11 (apt installs through aurora-admin, verified against root-owned DEP-11 lists; image packages never removable); merged catalogue UI; see docs/STORE-SOURCES.md |
| Visual redesign (user request, 2026-10-11) | **done** (2026-10-12) — brief in docs/design/BRIEF.md (all user answers), system in docs/design/SYSTEM.md; styles Nocturne (default) / Éclipse / Clair de lune / Contraste élevé × ambiances × accents; Phosphor icons, Manrope + Inter, new app icons, wallpapers, logo, GRUB/Plymouth; Windows names replaced (Lanceur, Fichiers, Moniteur système…); bar icons centred in every style |
| Themes Halo / Prisme / Sobre (user request, 2026-10-12) | **done** — mockups in docs/design/mockups-mix/{halo,prisme}; setting `finish` (core/finishes.js), wallpaper-tinted Mica-like glass (pre-blurred wallpaper behind windows, live blur only on bar / Lanceur / panels), icon packs halo / prisme (+ 'auto' follows the theme), wallpapers halo-* / prisme-* (light + dark); Sobre = the previous Selene look |
| NVIDIA drivers (user request, 2026-10-12) | **done (untested on real hardware)** — iso/packages.d/drivers.list (ubuntu-drivers-common, mokutil, pciutils), shell/main/lib/gpu-drivers.js, installer « Pilote graphique » step + aurora-install --nvidia-driver (apt in the target, ubuntu-drivers install, never fails the install), session uses nvidia when loaded (aurora_gpu_mode / aurora-xstart), Paramètres > Pilotes graphiques (main/ipc/drivers.js, aurora-admin drivers-install / drivers-remove) |
| Gaming apps option (user request, 2026-10-13) | **done** — installer « Jeux » step (Steam, Heroic, Lutris, ProtonUp-Qt checked; Bottles, Discord optional), aurora-install --gaming (allow-list) writes ~/.config/aurora/first-login/gaming.json, shell/main/ipc/firstlogin.js + core/features/gaming-setup.js install them per user from Flathub at the first sign-in (progress notification, offline retry, once only); gamemode in iso/packages.d/gaming.list |
| System features (user request « occupe toi du 2. », 2026-10-13) | **done (untested on real hardware)** — Bluetooth: iso/packages.d/bluetooth.list (bluez, libspa-0.2-bluetooth), helpers/aurora-bluetooth (python, BlueZ D-Bus, pairing agent, no root), main/ipc/bluetooth.js, Paramètres > Bluetooth et appareils (pages/bluetooth.js), Réglages rapides tile, visible to phones while the page is open; Printing: iso/packages.d/printing.list (cups, cups-filters, ipp-usb, avahi + libnss-mdns, driverless IPP Everywhere), main/lib/cups.js + main/ipc/printers.js, aurora-admin printer-* actions, Paramètres > Imprimantes et scanners (pages/printers.js); print dialog core/print.js + main/ipc/print.js (qpdf / poppler-utils, iso/packages.d/printdialog.list) in Éditeur de texte, Lecteur PDF, Photos, Navigateur, Notes; Updates: Logithèque « Mises à jour » (Flathub app updates, badge, all / per app, « Annuler », check 2 min after sign-in then daily), install « Annuler » (process group, rollback, honest partial notice), Paramètres > Mises à jour « Microprogrammes » (fwupd, main/ipc/firmware.js, aurora-admin firmware-update, iso/packages.d/firmware-updates.list), Chromium in « À la une »; Screen reader: iso/packages.d/screen-reader.list (orca, speech-dispatcher, espeak-ng), main/ipc/screenreader.js, Accessibilité « Lecteur d'écran » + Super+Alt+S, Chromium accessibility on while Orca runs |
| Linux app integration, part 1 (track "trayn", 2026-10-13) | **done (untested on real hardware / real apps)** — helpers/aurora-sessionbus (python3-dbus, JSON lines, started by main/ipc/sessionbus.js): owns org.freedesktop.Notifications (spec 1.2: Notify with replaces_id, app_icon / image-data / image-path, markup stripped, actions, urgency, expire_timeout; CloseNotification, GetCapabilities, GetServerInformation « Selene », NotificationClosed / ActionInvoked) shown by core/features/dbus-notify.js as Selene toasts + centre (Ne pas déranger respected; critical = urgent like alarms) and org.kde.StatusNotifierWatcher + host: icons in the bar (core/features/tray.js, taskbar.setTrayRenderer, .tb-sni) with Activate / SecondaryActivate / Scroll, dbusmenu as a Selene menu, tooltips, Passive hidden, NeedsAttention dot, removed when the app leaves the bus. XDG autostart: main/ipc/autostart.js, run once per sign-in after the shell is ready (deny list for what Selene runs itself). iso/packages.d/tray.list (libnotify-bin). No XEmbed tray: no cheap bridge in noble (snixembed not packaged, xembedsniproxy = plasma-workspace). Tests: test/sessionbus.test.mjs (62 checks, private dbus-daemon + fake app + gdbus). Dev: helper off unless AURORA_SESSIONBUS=1 |
| Touchpad + power (gap list 0.a, inputpower track, 2026-10-13) | **done (untested on real hardware)** — tap-to-click by default (rootfs/etc/X11/xorg.conf.d/40-aurora-touchpad.conf), Paramètres > « Souris et pavé tactile » Pavé tactile section when xinput shows a touchpad (activé, toucher pour cliquer, défilement naturel, vitesse du défilement, désactiver pendant la saisie; xinput libinput props at sign-in and on change; gestures not done) — main/ipc/inputpower.js; core/features/power.js: screen off after inactivity (5 min battery / 10 min mains, xset dpms force off), lock when the screen turns off (accounts with a password), sleep after inactivity (15 min battery / never on mains), low battery 10 % / 5 % notifications, 3 % = 60 s countdown then sleep (plugging in cancels); settings key `power` (not in the shell defaults: dev/tests do nothing unless set); Paramètres > Alimentation « Écran et mise en veille », « Mode d’alimentation » (power-profiles-daemon, iso/packages.d/power.list), « Quand je ferme le capot » (aurora-admin power-lid -> logind.conf.d/50-aurora-lid.conf); Réglages rapides « Énergie » tile; test/inputpower.test.mjs (41) + inputpower.unit.mjs (18) on fake xinput / powerprofilesctl / xset / power_supply |
| Linux app integration part 2 — open / office / spelling / screen sharing (gap list 0.b, 2026-10-13) | **done (untested on real hardware)** — rootfs/usr/bin/aurora-open (python, validates: http(s) / mailto URLs, existing paths, file:// URIs) + NoDisplay rootfs/usr/share/applications/aurora-{browser,mail,files,notepad,photos,media,pdf,archive}.desktop + rootfs/etc/xdg/mimeapps.list (user's ~/.config/mimeapps.list still wins, e.g. a Flathub browser) -> unix socket $XDG_RUNTIME_DIR/aurora/open.sock (main/ipc/xdgopen.js, re-validates) -> core/features/xdgopen.js; office documents with no handler: core/features/office.js « Pour ouvrir ce document, installez LibreOffice » -> store:install flathub org.libreoffice.LibreOffice (per user, progress notification) then opens the file (registry.handlerFor matches Linux apps by MIME type), from Fichiers, Courrier attachments and aurora-open; spell check: Chromium .bdic fr-FR + en-US in rootfs/usr/share/aurora/dictionaries (from Electron's hunspell_dictionaries.zip, sha256-checked by tools/fetch-dictionaries.sh) copied into the session's Dictionaries dir, download URL pointed at a closed local port (main/ipc/spell.js), prose fields only (`data-prose`; core/features/spell.js: right-click suggestions + « Ajouter au dictionnaire »), Paramètres > Langue et région « Vérifier l'orthographe » (setting `spellcheck`, default on), Navigateur fields too; screen sharing: browser sessions' setDisplayMediaRequestHandler + desktopCapturer + picker (apps/browser/lib/screenshare.js, cancel = refusal); suite shell/test/openoffice.test.mjs (47 checks) |
| Real-PC image + system updates (gap list 0.a, track "image", 2026-10-13) | **done (untested on real hardware)** — iso/config.sh defaults: `WITH_FIRMWARE=1` (linux-firmware, ~+600 MB; `WITH_FIRMWARE=0` keeps the placeholder for quick VM builds) and `KERNEL_PACKAGE=linux-image-generic-hwe-24.04` (7.0.0-34 in the 20261001 snapshot; pulls intel/amd64-microcode; ubuntu-drivers then picks linux-modules-nvidia-*-generic-hwe-24.04, which exist for 7.0.0-34). Secure Boot: iso/build.sh make_secureboot_efi + a grub-mkrescue `--xorriso` wrapper swap grub-mkrescue's EFI image (and the ISO's /efi/boot) for shim-signed (BOOTX64.EFI) + grub-efi-amd64-signed's gcdx64.efi.signed (grubx64.efi) + mmx64.efi from the package layer, grub.cfg stubs in EFI/BOOT and EFI/ubuntu; BIOS side unchanged; under Secure Boot GRUB refuses loadfont, so the menu is plain text (theme kept without Secure Boot). System updates: iso/packages.d/release.list (unattended-upgrades), rootfs/etc/apt/apt.conf.d/21aurora-auto-upgrades (lists daily, unattended-upgrade, autoclean 7 d) + 52aurora-unattended-upgrades (Remove-Unused-Kernel-Packages), apt-daily* / unattended-upgrades units skipped in the live session (aurora-live.conf drop-ins); aurora-admin apt-autoremove, run by admin.js as the follow-up (`then`) of apt-upgrade with the same authorization (one prompt, « Nettoyage des anciennes versions… »); background check main/ipc/updates.js (`apt-get -s upgrade` as the user, no root) + core/features/update-check.js (5 min after sign-in then daily, not in the live session): notification « N mises à jour disponibles » → Paramètres > Mises à jour, count badge on that nav entry. build.sh honours `AURORA_BUILD_LOCK_HELD=1` (run under `flock work/.build.lock`). Tests: shell/test/update-check.test.mjs (59; dev shells only check when AURORA_UPDATE_CHECK_DELAY_MS is set); verify-iso checks (signed shim / GRUB, signed vmlinuz, kernel = modules, HWE, microcode, firmware files, unattended-upgrades config, live drop-ins) |
| Selene self-updates (gap list 0.c, track "selfupdate", 2026-10-13) | **done (untested on an installed system)** — docs/UPDATES.md. VERSION file (1.0.0; ISO name, os-release); tools/build-debs.sh (`make debs`, no root) builds aurora-electron (`<electron>-1`, /opt/aurora/electron), aurora-shell (`<VERSION>-<git commit count>`, /opt/aurora/shell + node_modules + selene-version; Depends aurora-electron (>= 44.7.0), aurora-base (>= VERSION)) and aurora-base (rootfs/ overlay, /etc = conffiles, maintainer scripts: daemon-reload, tmpfiles, AppArmor reload, units enabled like dh_installsystemd, os-release diversion + rewrite; Ubuntu-owned files listed in packaging/aurora-base/diversions ship as `<file>.selene` + symlink, Ubuntu's diverted to `<file>.ubuntu`; selene.sources + keyring). iso/build.sh install_selene_debs replaces install_electron / install_shell / install_rootfs_overlay (dpkg -i in the chroot; dies naming any new rootfs/ file an Ubuntu package owns). tools/build-repo.sh (`make repo`): signed apt repo out/apt (pool, noble/main/binary-amd64, InRelease + Release.gpg, no apt-ftparchive needed); tools/selene-key.sh: key in gitignored keys/ (created on this build host 2026-10-13, fingerprint 1BA5D8BC502685F31AD88689FAC7D4D25A557022 — back it up or regenerate), public keyring iso/keys/selene-archive-keyring.gpg; `make release VERSION=x.y.z` (tools/release.sh: bump, debs, repo, docs/releases/x.y.z.md skeleton). SELENE_APT_URL (iso/config.sh, default https://belzeeebuth.github.io/claudeai-test/apt/, not published yet). aurora-admin apt_update: apt-check, store installs and drivers-install (--error-on=any) retry `apt-get update` without selene.sources when it fails (404 / bad signature / unreachable). Paramètres > Mises à jour: one « Selene 1.0.1 » entry (lib/selene-updates.js), « Redémarrer la session » after an aurora-shell / Electron update (main/ipc/selene-update.js compares selene-version with the running one). Tests: tools/test-selfupdate.sh (root, throwaway minbase root: install with a stand-in greetd, signed-repo upgrade, failing-repo fallback ×3, removal), shell/test/selene-updates.test.mjs (unit + UI, AURORA_DEV_SELENE_UPDATE=1); verify-iso « Selene packages » block (dpkg -S owners, conffiles, diversions + symlinks, selene.sources, keyring) |
| Release readiness, lots 1–3 (user request, 2026-10-13) | **done (untested on real hardware)** — image: linux-firmware by default (WITH_FIRMWARE=0 = quick VM build), live ISO boots with Secure Boot (Microsoft-signed shim + Canonical gcdx64 from the image; plain-text GRUB under SB), HWE kernel, unattended-upgrades (security, installed systems only), background apt check + notification + badge, apt-autoremove; input / power: libinput tap-to-click, Pavé tactile settings, screen off / lock at screen off / idle sleep on battery, lid action (aurora-admin power-lid), power-profiles-daemon modes, low battery alerts + 3 % countdown, org.freedesktop.ScreenSaver / PowerManagement inhibitors (video keeps the screen on); robustness: renderer crash / hang reload (stays locked, backs off, gives up after 6), safe mode (AURORA_SAFE_MODE, banner → pill), settings.json backup, low disk notice, earlyoom, renderer errors in the journal, diagnostic report, installer low-RAM warning; Linux apps: helpers/aurora-sessionbus (notification server, StatusNotifierItem tray with dbusmenu, inhibitors), XDG autostart, aurora-open + hidden .desktop handlers + mimeapps, LibreOffice prompt for office files, local fr/en spell check (.bdic), Navigateur screen sharing; self-updates: aurora-electron / aurora-shell / aurora-base .debs (tools/build-debs.sh), signed repo (make repo), make release, selene.sources disabled until the repo answers then auto-enabled, docs/UPDATES.md |
| Dual boot « Installer à côté » (user request, 2026-10-13) | **built, loop-tested (112 checks); validated end to end in QEMU/KVM on 2026-10-14 with no hand fix (ISO sha256 37d24971…)** on a 64 GiB copy of the user's PC built without root (NVMe GPT, same sector layout; 4 GiB FAT32 ESP with the real Limine 12.9 in EFI/limine + EFI/BOOT, limine.conf, fake kernels; ext4 CachyOS root with no free space, /etc/os-release CachyOS + /usr/lib/os-release Arch as on the real system, 2.3 GiB of data and 251 inodes past the cut; NVRAM « Limine » first, live ISO started through BootNext): installer argv computed by the app's own code for 25 GiB (`--shrink 2 --new-size 35836 --root-size 25600`), install 30 s, then NVRAM « Selene » first and Limine second, GRUB menu Selene / other system, that entry shows the real Limine menu, Selene reaches the greeter; all 1189 ext4 entries (content, mode, owner, mtime) and the 9 ESP files identical, only EFI/ubuntu added, e2fsck clean. **Open: the other system is named « Arch Linux » instead of « CachyOS »** in the installer and in GRUB (aurora-disk-probe probe_ext4 reads /usr/lib/os-release before /etc/os-release, contrary to os-release(5); test-alongside.sh's cachy.img has only /etc/os-release). Images, manifests and scripts: work/qemu/dualboot/ (local, gitignored) — helpers/aurora-disk-probe (read-only survey: UEFI/GPT, free space, NTFS / ext4 shrink bounds, BitLocker, Fast Startup, dirty, LUKS / LVM / btrfs / xfs refusals, ESP checks, chain-loader name), aurora-install --alongside (--free-space / --shrink / --reuse-partition, fingerprint re-check, shrink then create, other entries unchanged, ESP backup + byte-exact restore + NVRAM rollback on failure, grub-install --no-extra-removable + wrapper on the installed system, efibootmgr « Selene » first, os-prober for Windows, chainload entries for Limine / systemd-boot / rEFInd / other GRUB named after the other system, 5 s menu), installer UI (à côté / effacer, size slider, exact summary, backup checkbox, reasons). User's PC: NVMe 477 G, ESP 4 G on /boot with Limine, ext4 root 473 G, UEFI, SB off. |
| App phase 2 (PHASEAPP.md, 2026-10-13) | **done** — camera, recorder (Enregistreur vocal), screenrec (Enregistreur d'écran), code (Éditeur de code, CodeMirror 6 vendored by tools/vendor-codemirror.mjs), « Musique » = Lanceur alias of the Lecteur on its music library (albums, artists, songs, lyrics); Video Editor dropped by the user (DaVinci Resolve / Flathub editors); ffmpeg in the image (iso/packages.d/screenrec.list) |
| App phase 5 (PHASEAPP.md, 2026-10-14) | **done** — books (Livres, EPUB), scan (Numérisation, SANE + airscan; Paramètres > Imprimantes et scanners section), logs (Journaux système, journalctl; « Voir le journal » from the Moniteur système), fonts (Polices), help (Aide, ~70 articles + « Bien démarrer » tour), feeds (Podcasts et actus); shell features emoji / symbols panel (Super+.), Loupe (magnifier), Clavier visuel (on-screen keyboard, also on the greeter); icons in the three styles. Image: desktop firmware only (aurora-firmware-desktop Provides linux-firmware, ~165 MB of server firmware dropped) + firmware-sof-signed (Intel laptop audio) |
| « Later » items of phases 2–4 (2026-10-14) | **done (tested with fakes only)** — code: search / replace across files, split view, diff (@codemirror/merge); disks: « Santé du disque » (udisks2 SMART over busctl, self-tests, aurora-admin smart-info, core/features/disk-health.js notification, smartmontools); nettools: OpenVPN import (passwords via nmcli passwd-file or `connection edit` stdin), traceroute, port check, listening ports, Cloudflare speed test (network-manager-openvpn, iputils-tracepath); maps: « Itinéraire » (OSRM FOSSGIS, lib/directions.js); remote: RDP through FreeRDP 3 (`xfreerdp3 /args-from:stdin`, /cert:deny + fingerprint dialog, freerdp3-x11), VNC Hextile / ZRLE / Tight / Cursor + clipboard; media: MPRIS (aurora-sessionbus exports org.mpris.MediaPlayer2.selene and watches other players), media card in Réglages rapides (core/features/mediactl.js), media keys (also grabbed by aurora-xwm), Podcasts folder left out of the music library. Details in PHASEAPP.md |

### App / area status (every area has its own test suite in shell/test/)

| Area | Checks in the last full run |
|---|---|
| Shell UX, window management, login/lock, Settings | shell-ux 375, wm-nav 241, login-lock 302, system-settings 158 |
| Browser, Files, Mail | browser 67 tests, files 274, mail 44 |
| Paint, Calculator, Notepad, Terminal, Media, Snipping, Task Manager, Installer | paint 51 tests, calculator 672, notepad 289, terminal 246, media 48, snipping 40, taskmgr 173, installer 161 |
| Games | games-classic 85, solitaire 72, chess 68 |
| Phase 1 apps | photos 46, pdf 244, archive 468, notes 262 + 156 unit, calendar 378 + 131 unit, clock 448, todo 361 |
| Voice Recorder (phase 2, recorder) | recorder 56 + 17 unit (fake microphone; no real microphone tested) |
| Screen Recorder (phase 2, screenrec) | screenrec 64 + 34 unit (Xvfb screen capture, Chromium fake microphone; computer sound and real hardware not tested) |
| Code Editor (phase 2, code) | code 74 + 11 unit (CodeMirror 6 vendored bundle; git and the PTY terminal tested for real under Xvfb); code-extra 115 (search / split / diff) |
| « Later » items (2026-10-14 evening, 19 suites run together) | disks 68 + disks-health 172, nettools 105 + nettools-extra 263, maps 124 + maps-routes 208, remote 135 + remote-extra 149, sessionbus 118, music 14, media 48, shell-ux 457, wm-nav 255, login-lock 298, icons 118 |
| Phase 5 apps and features (2026-10-14, each run alone, not yet in a full sweep) | books 241, scan 148 + 83 unit, logs 332, fonts 142, help 115, feeds 172, emoji 154, magnifier 122, osk 141 |
| Personalization | personalization-core 144, personalization-shell 90, taskbar-start-focus 269, packs-input 148, wallpapers 300 |
| Core | smoke, core-dialogs 6 |
| Linux GUI apps + Store sources | xwm-helper 78, xwin 63 (incl. real xterm end-to-end), xapps 71, store 128, store-flathub 83, store-ubuntu 84 |

**Full sweep 2026-10-14 night, on the user's PC** (85 suites: the 19 « later » suites, then the other 66 with -j 6):
82 green. Fixed during the sweep (test-side, host differences): xapps (its fake program fixtures/xapps/bin/ had never
been committed: the root .gitignore ignores every bin/), taskmgr (Node 26 names its main thread « node-MainThread »),
terminal (the developer's login shell is fish: tests now pin bash with AURORA_PTY_LOGIN_SHELL, honoured by aurora-pty
and main/ipc/pty.js). Still red on this PC only: terminal « tab title shows the running command » (CachyOS's
/etc/bash.bashrc rewrites the title; Ubuntu's does not), xwm-helper (needs xeyes, xterm and a system python3-xlib),
and xvfb-run sometimes exits non-zero after a green suite (run-all --retry).
Last full sweep (2026-10-12 ~12:00 Paris, after the follow-ups): 52/52 suites green (pdf needed its retry; personalization-core's leak check fixed to count from a quiet screen). Previous sweep (2026-10-12, after the redesign): 50/50 suites green (48 in the sweep with --retry: wm-nav, personalization-core and personalization-shell needed their retry; icons and packs-input fixed for renamed labels and re-run alone; taskmgr 192 and paint 51 run separately).

## File structure

```
aurora-os/
  README.md  PHASEAPP.md  PROJECT_STATE.md  Makefile
  docs/BUILDING.md        build, QEMU run/install instructions (EN + FR)
  docs/DEVELOPING.md      architecture, app contract, UI kit, backend API (all channels), app list
  docs/PERSONALIZATION.md settings schema and behaviour of every personalization feature (+ magnifier / OSK keys)
  docs/XWINDOWS.md  STORE-SOURCES.md  UPDATES.md   Linux X11 apps, Store sources, Selene self-updates
  docs/design/            redesign brief (user answers), design system, mockups, previews
  docs/screenshots/       test screenshots
  iso/config.sh build.sh Dockerfile packages.d/*.list   ISO build (debootstrap → squashfs → grub-mkrescue)
  rootfs/                 overlay copied into the image (session scripts, greetd, polkit, sudoers, helpers)
    usr/lib/aurora/helpers/  aurora-admin (allow-listed root actions), aurora-install, aurora-disk-probe (dual boot
                             survey), aurora-pty, aurora-checkpass (PAM), aurora-apply-display, aurora-xwm,
                             aurora-sessionbus, aurora-bluetooth
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

- Redesign leftovers (small, from the last reviewers): in Nocturne / Clair de lune, opening « Aujourd'hui » highlights
  the whole clock button including the bell (Éclipse has separate states); Moniteur système with a GPU at the 600 px
  minimum width truncates the Réseau meter; the Processus table leaves ~60 px empty on the right when Statut is hidden;
  Dessin's « Image » menu name is also a Windows Paint group name; Vue d'ensemble / lock / Ctrl+Alt+Del not checked in
  high contrast. Workflow scripts for the redesign phases were in the session scratchpad (redesign-a…e.js).

- Halo / Prisme glass in software rendering (no GPU, xvfb / QEMU without 3D): each window repaints the pre-blurred
  wallpaper (`fixed` background), ~10 ms per window; opening or closing 60 windows at once stalls the shell ~600 ms
  (Sobre: none). Normal use (a few windows) is fine; a cheaper material for many windows is a possible follow-up.
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
  Flatpak runtimes are big (live session keeps them in RAM). Updates view and install cancel added 2026-10-13.
- Build host leftovers: empty /cdrom and /usr/lib/aurora (harmless).
- System features (2026-10-13) were built against fixtures and fake binaries (no adapter, printer, firmware device or
  sound card in the build container). To check on real hardware: Bluetooth pairing (phone, headset with A2DP / HFP in
  Son, mouse, keyboard passkey, gamepad), rfkill blocks; a real IPP Everywhere printer (discovery, add, test page, ink
  levels, lp -o options, landscape rotation of the print dialog's PDF); fwupd JSON from a real daemon, whether
  `fwupdmgr refresh` needs polkit, a UEFI capsule update with Secure Boot; real `flatpak remote-ls --updates` / update
  progress / cancel; Orca speech in French, hot-enabling Chromium accessibility, GTK / Qt apps read by Orca.
  Small leftovers: printer-add retry after « already exists » asks for the admin password twice; the screen reader
  toast briefly shows a notification badge; ui.toggle switches are announced as checkboxes (no role="switch"); no
  desktop notification for new app updates (badge only); « Tout mettre à jour » stops if the Logithèque is closed;
  no screen reader on the login screen; scanners not supported.

- Linux app integration part 2 (2026-10-13) was built against fixtures (dev Flathub simulation, a LibreOffice .desktop
  written by the test, xvfb screen). To check in the VM: xdg-open / gio open / a Flatpak app's OpenURI portal reaching
  aurora-open (the portal may first show its app chooser), a real Flathub LibreOffice install then opening the .docx;
  screen sharing on a real site (the picker lists the whole screen + X11 app windows; Selene's own windows are part of
  the screen); a refused share reaches the page as AbortError (Electron), not NotAllowedError. A word added with
  « Ajouter au dictionnaire » is saved at once, but webFrame.isWordMisspelled keeps its cache until the text is re-checked.

- Real-PC image (track "image", 2026-10-13): Secure Boot checked only in QEMU (OVMF_CODE_4M.secboot.fd +
  OVMF_VARS_4M.ms.fd, TCG): shim → signed GRUB menu (text, no theme) → HWE 7.0 kernel (« secureboot: Secure boot
  enabled », lockdown) → casper mounts the squashfs (casper-bottom); without Secure Boot the themed menu is unchanged.
  ISO with firmware + HWE: 1.6 GB (was 873 MB).
  To check on real PCs: Secure Boot on a real firmware (and with the 2023 Microsoft UEFI CA only), USB boot of the
  hybrid image, Wi-Fi / GPU / Bluetooth firmware actually loading (iwlwifi, amdgpu, i915 GuC/DMC, rtw88/89, brcm), the
  HWE 7.0 kernel on real laptops, the NVIDIA path (aurora-install --nvidia-driver + MOK) with the HWE kernel, a real
  unattended-upgrades run and old-kernel removal on an installed system, apt-autoremove after « Mettre à jour ». The
  installed system's GRUB / shim come from aurora-install (not changed here). The background check counts what the
  lists apt-daily refreshed (as root, daily): before the first refresh it shows nothing.

- Selene self-updates (2026-10-13): the system stage with the debs ran here (14:27, `--from system --until system`:
  dpkg -i OK, validate_system / assert_clean_image OK, verify-iso's « Selene packages » block 20/20 on the layer, shell
  108M / 42 npm packages as before) but the squashfs / ISO were NOT rebuilt (time box): out/*.iso predates the
  packaging and fails that block with one line (« no Selene packages in the image »). Next image build:
  `flock work/.build.lock iso/build.sh --from squashfs` (or --from system), then make verify-iso / smoke-image. The Selene repository is not published yet:
  until it is, installed systems see a 404 for selene.sources (aurora-admin falls back; `apt update` by hand and
  apt.systemd.daily report an error) — publish out/apt/ before shipping the image. To check on an installed system:
  a real update through Paramètres (download from the published repo, session restart into the new shell, AppArmor
  reload, daemon-reload), unattended-upgrades with the Selene origin (not in its Allowed-Origins: Selene updates are
  manual for now). The image track's background update count (main/ipc/updates.js) counts Selene's packages one by
  one (lib/selene-updates.js groupSelene could make it 1). A system installed from an older image has no aurora-*
  packages: one manual `apt install ./aurora-*.deb`.
- Robustness (track "robust", 2026-10-13, test/robust.test.mjs 58 checks): renderer crash / hang recovery
  (main/lib/robust.js: reload, stays locked, 3 crashes in 2 min -> safe mode; renderer errors -> journal as
  `[renderer:<app>]`), aurora-xsession safe mode after 2 shell crashes (AURORA_SAFE_MODE=1), safe-mode banner
  (core/features/robust.js; settings.js overlays a Sobre look, autostart.js skips), settings.json.last-good backup +
  restore + ENOSPC-safe writes, low disk notice (home < 5 % or < 1 GB; dev mode only with AURORA_FAKE_DISK), earlyoom
  (iso/packages.d/robust.list + /etc/default/aurora-earlyoom drop-in; chosen over systemd-oomd, which would kill the
  whole session scope), installer low-RAM warning (< 3.5 GiB seen), « Créer un rapport de diagnostic » in À propos,
  os-release SUPPORT_URL / BUG_REPORT_URL. To check on real hardware / in the image: earlyoom actually sparing the
  shell under memory pressure; journalctl _UID readable by the user (persistent journal); lsusb/lspci present;
  a real Electron 'unresponsive' (tests emit the event); the image not yet rebuilt with these changes.

- Small inconsistencies found while writing the Aide articles (2026-10-14, not fixed yet): « Restaurer tous les
  raccourcis » shows the pinned-apps toast; Réglages rapides Wi-Fi « Se connecter automatiquement » is never sent;
  the Ethernet page promises IP / DNS settings but is read-only; « Changer d'utilisateur » signs out from the lock
  screen but only locks from Ctrl+Alt+Del; the forgotten-password text points to Paramètres > Comptes (the reset is
  under Autres utilisateurs); a straight apostrophe in taskview.js.
- Found while finishing the « later » items (not fixed): `ui.filePicker({ mode: 'folder' })` — Enter in the path field
  accepts the OLD folder (the dialog's Enter handler runs before the field's navigation); two RDP sessions with the
  same name can swap their « Afficher » buttons; port checks cannot be cancelled; the speed test ignores proxies;
  the media card is only in Réglages rapides (not the notification centre), no MPRIS TrackList.
- To check on real hardware / servers (everything above was built against fakes): udisks2 SMART on real SATA / NVMe /
  USB drives and the polkit self-test grant; an OpenVPN profile on a real NetworkManager (error wording, the
  `nmcli connection edit` stdin path); real OSRM / Nominatim answers; a Windows 10/11 RDP server with NLA, its
  certificate, `/dynamic-resolution` while resizing, clipboard and drive redirection; Spotify / VLC / a browser over
  MPRIS, real media keys and a Bluetooth headset (AVRCP keys through BlueZ's uinput device).
- test/xwm-helper.test.mjs cannot run on the user's PC (needs xterm, xeyes and a system python3-xlib): the new media
  keysyms in aurora-xwm were checked against python-xlib's values only.
- Tests: Electron now always starts with --mute-audio (2026-10-14): Xvfb has no audio, so test sounds and media
  played on the developer's real PipeWire session. login-lock's « through sudo » checks no longer depend on the host's
  PAM (non-root: must not authenticate). xvfb-run sometimes exits non-zero after a suite passed (« kill: no such
  process » when Xvfb is already gone); run-all's --retry absorbs it.
- Tests and Wayland (fixed 2026-10-14): when WAYLAND_DISPLAY was set, the tests started Electron on the developer's
  real Wayland session (test windows on the real screen, clipboard overwritten). lib.mjs and login-lock now force
  `--ozone-platform=x11` on xvfb-run's display and drop the Wayland variables.

## Next steps (exact)

1. **Dual boot naming (waiting for the user's go).** The other system shows as « Arch Linux » instead of « CachyOS »
   in the installer and in GRUB: aurora-disk-probe (probe_ext4, ~line 350) reads /usr/lib/os-release before
   /etc/os-release, contrary to os-release(5). Fix: read /etc/os-release first, then /usr/lib/os-release (a symlinked
   /etc/os-release gives no NAME and falls through); add a /usr/lib/os-release « Arch Linux » to test-alongside.sh's
   cachy.img; rebuild the ISO and re-run the VM validation from work/qemu/dualboot (ref.qcow2 + vars-ref.fd = the
   prepared CachyOS disk; scripts/).

2. **Session of 2026-10-14.** Afternoon: app phase 5 (PHASEAPP.md), its icons, Mémos / Traducteur removed,
   desktop-only firmware + firmware-sof-signed, docs reviewed. Evening: the six « later » items finished by six agents
   resumed from the stopped ones' prompts (prompts and briefs in ~/.cache/selene-dev/BRIEF-agents.md), each committed
   separately, then the 19 suites they touch run together: 19/19 green (code, code.unit and login-lock on retry —
   see Known issues).

3. **Add the verify-iso checks for the
   new packages.d lists (books, emoji, fonts, scanner, disks: smartmontools, nettools: network-manager-openvpn +
   iputils-tracepath, remote: freerdp3-x11) and the files the agents suggested (aurora-sessionbus MPRIS name,
   aurora-xwm media keysyms, aurora-admin smart-info, polkit udisks2 self-test actions, nm-openvpn plugin files,
   `xfreerdp3 --version` 3.x). Only then: ISO rebuild by the user (`flock work/.build.lock iso/build.sh --from
   packages`: new package lists), make verify-iso and make smoke-image. Do not rebuild the ISO before the sweep.

4. **Real-world checks** of the « later » items in the VM / on the user's PC (list under Known issues).

5. **Small fixes:** the inconsistencies listed under Known issues (Aide list, filePicker Enter); Cloud real client ignores back-pressure
   and shows 100 % for chunked downloads; Remote Desktop scaled canvas is blurry (image-rendering); weather:current
   still makes a real request in dev (wallpapers test expects it).

6. **Gap list (2026-10-13), still open:** publish the Selene apt repository (make repo -> out/apt/ on GitHub Pages at
   SELENE_APT_URL; the archive key is in keys/, gitignored — back it up); XEmbed-only tray icons are not shown (no noble
   bridge); GRUB is plain text under Secure Boot; LibreOffice is offered from Flathub only; mpv's X11 screensaver
   inhibit untested; Selene packages are not in unattended-upgrades.
   Later: multi-monitor, HiDPI for X apps, keyboard layout switcher + IME, per-app volume + Bluetooth profiles,
   network (static IP, proxy, 802.1X, hotspot, captive portal), USB automount / MTP / SMB, keyring (gnome-keyring +
   PAM), installer LUKS, recovery, sticky keys, online accounts / CalDAV / Mail OAuth2, codecs / HEIC, CI, LICENSE for
   aurora-os, release notes + signed ISO (done since: dual boot installer, magnifier, on-screen keyboard).

7. **Waiting for the user:** QEMU feedback on the redesigned ISO; the Éclipse bar (search field + labelled running
   apps) still reads like Windows 10 to the reviewers — offer to make it icon-only by default like the two other
   styles; Snake arrow keys reported as not working (fine in the agent's VM with real key events: likely host / QEMU
   keyboard side; asked whether Space works and whether arrows work elsewhere).

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
