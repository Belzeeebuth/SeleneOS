# Selene OS — app roadmap

Apps are added phase by phase. Only one phase is built at a time; the next one starts when the
user asks for it. Status is also tracked in [PROJECT_STATE.md](PROJECT_STATE.md).

Every new app follows the app contract in [docs/DEVELOPING.md](docs/DEVELOPING.md): an app folder
under `shell/renderer/apps/<id>/` with a manifest, EN + FR strings, a Selene app icon (docs/design/SYSTEM.md),
light and dark themes, and a Playwright test in `shell/test/<id>.test.mjs`.

## Phase 1 — Core apps (done, 2026-10-11)

| App | id | Notes |
|---|---|---|
| Photos | `photos` | Default app for images (`defaultFor`); gallery, viewer, light editing, slideshow |
| Calendar | `calendar` | Month/week/day/agenda views, events with reminders via `shell.reminders`, .ics import/export |
| Clock | `clock` | Alarms (`shell.reminders`, kind `alarm`), timers, stopwatch, world clock, focus sessions |
| Notes | `notes` | Notebooks, rich text, search, pin, autosave |
| To Do / Reminders | `todo` | Lists, My Day, Important, Planned, steps, due dates, reminders via `shell.reminders` |
| PDF Reader | `pdf` | pdf.js (`pdfjs-dist`), thumbnails, search, zoom, rotate, highlights/notes; printing through the Selene print dialog (2026-10-13) |
| Archive Manager | `archive` | zip / tar / tar.gz / tar.xz / 7z / rar (read) via libarchive `bsdtar` + `7z` |

All seven are built and independently verified, each with its own test suite (`shell/test/<id>.test.mjs`;
Calendar and Notes also have `*.unit.mjs`).

## Phase 2 — Media and productivity (done, 2026-10-13)

| App | id | Notes |
|---|---|---|
| Camera | `camera` | `getUserMedia`; photo (JPEG) + video (WebM VP9/Opus) to Pictures/Camera Roll (FR « Pellicule »), timer, mirror, grid, camera / resolution choice; the webcam is released when minimized; QEMU needs a webcam passthrough to test |
| Voice Recorder | `recorder` | MediaRecorder (Opus/WebM), live waveform, pause, markers, trim (copy / replace), microphone choice + level, MP3 / M4A export (ffmpeg); Documents/Sound recordings |
| Screen Recorder | `screenrec` | `desktopCapturer` (screens only, queued) → WebM, MP4 through ffmpeg; whole screen or an area, microphone / computer sound, countdown, floating control kept out of the video, tray chip, Super+Shift+R |
| Music | `music` | Lanceur alias of the Lecteur (no second player): Albums, Artistes, Titres (+ Genres), synced .lrc / embedded lyrics, shuffle all. Later: MPRIS / global media keys |
| Code Editor | `code` | CodeMirror 6 (vendored bundle, tools/vendor-codemirror.mjs), folder tree with git status, tabs, find / replace, terminal panel (pty backend), branch in the status bar. Later: search across files, split view, diff |

The Video Editor was dropped at the user's request (DaVinci Resolve and the Flathub editors such as Kdenlive / Shotcut cover it).

## Phase 3 — System and connectivity (done, 2026-10-11)

| App | id (planned) | Notes for later |
|---|---|---|
| App Store | `store` | Curated catalog of command-line tools/services installed with APT through `aurora-admin` (allow-listed; tools shipped with the image cannot be removed). Since then: the whole Flathub and Ubuntu desktop catalogues, Flatpak updates view and install cancel (done 2026-10-13) |
| Disk Utility | `disks` | `lsblk`/`udisksctl`: drives, partitions, mount, eject; format removable drives only (`aurora-admin format-removable`). Later: SMART |
| Backup | `backup` | rsync snapshots (`--link-dest`) of chosen home folders to a drive/folder, browse, restore, keep last N, reminders |
| Password Manager | `passwords` | Encrypted vault (WebCrypto AES-GCM + PBKDF2 600k), auto-lock, generator, CSV import/export. Later: browser autofill |
| Cloud Drive | `cloud` | **Light version:** Nextcloud/WebDAV browse, upload, download. Later: rclone mounts (Google Drive, OneDrive) in File Explorer |
| VPN / Network tools | `nettools` | **Light version:** NetworkManager VPN/WireGuard list, connect, WireGuard import; ping; DNS lookup. Later: OpenVPN, traceroute, port check, speed test |

## Phase 4 — Extras (done, 2026-10-11)

| App | id (planned) | Notes for later |
|---|---|---|
| Weather | `weather` | Open-Meteo (no API key), city search, 24 h + 7-day forecast, saved places, °C/°F; sets the dynamic wallpaper location |
| Maps | `maps` | OpenStreetMap tiles in a custom viewer, Nominatim search, saved places. Later: routes (OSRM) |
| Contacts | `contacts` | JSON store, vCard 3.0/4.0 import/export, favourites, Mail recipient suggestions |
| Remote Desktop | `remote` | VNC client in the shell (TCP bridged by the main process). Later: RDP, clipboard, more encodings |

Sticky Notes (`sticky`, « Mémos ») and Dictionary / Translator (`translate`) were removed at the user's request on 2026-10-14 (Notes covers the first; online translation sites in the Navigateur do better than the free MyMemory quota).
