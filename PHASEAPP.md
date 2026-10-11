# Aurora OS — app roadmap

Apps are added phase by phase. Only one phase is built at a time; the next one starts when the
user asks for it. Status is also tracked in [PROJECT_STATE.md](PROJECT_STATE.md).

Every new app follows the app contract in [docs/DEVELOPING.md](docs/DEVELOPING.md): an app folder
under `shell/renderer/apps/<id>/` with a manifest, EN + FR strings, an original Fluent-style icon,
light and dark themes, and a Playwright test in `shell/test/<id>.test.mjs`.

## Phase 1 — Core apps (done, 2026-10-11)

| App | id | Notes |
|---|---|---|
| Photos | `photos` | Default app for images (`defaultFor`); gallery, viewer, light editing, slideshow |
| Calendar | `calendar` | Month/week/day/agenda views, events with reminders via `shell.reminders`, .ics import/export |
| Clock | `clock` | Alarms (`shell.reminders`, kind `alarm`), timers, stopwatch, world clock, focus sessions |
| Notes | `notes` | Notebooks, rich text, search, pin, autosave |
| To Do / Reminders | `todo` | Lists, My Day, Important, Planned, steps, due dates, reminders via `shell.reminders` |
| PDF Reader | `pdf` | pdf.js (`pdfjs-dist`), thumbnails, search, zoom, rotate, print-free, highlights/notes |
| Archive Manager | `archive` | zip / tar / tar.gz / tar.xz / 7z / rar (read) via libarchive `bsdtar` + `7z` |

All seven are built and independently verified, each with its own test suite (`shell/test/<id>.test.mjs`;
Calendar and Notes also have `*.unit.mjs`).

## Phase 2 — Media and productivity (next — waits for the user's go)

| App | id (planned) | Notes for later |
|---|---|---|
| Camera | `camera` | `getUserMedia`; photo + video capture to ~/Pictures/Camera Roll; QEMU needs a webcam passthrough to test |
| Voice Recorder | `recorder` | MediaRecorder (Opus/WebM), waveform, trim, markers; saves to ~/Documents/Sound recordings |
| Screen Recorder | `screenrec` | `desktopCapturer` / shell capture stream → WebM; could live inside Snipping Tool as "Record" mode |
| Music | `music` | Could extend the Media Player library (albums/artists views, lyrics) or be a separate music app |
| Video Editor | `videoeditor` | Timeline (trim, split, text, transitions) → export via WebCodecs/MediaRecorder or ffmpeg in the image |
| Code Editor | `code` | Monaco or CodeMirror (new npm dependency), file tree, tabs, terminal panel (reuse pty backend), git status |

## Phase 3 — System and connectivity

| App | id (planned) | Notes for later |
|---|---|---|
| App Store | `store` | Curated catalog of Flatpak/APT apps installed through `aurora-admin` (allow-listed); updates view |
| Disk Utility | `disks` | udisks2 over D-Bus or `udisksctl`/`lsblk`/`parted`: partitions, format, SMART, mount options |
| Backup | `backup` | rsync/restic snapshots of the home folder to a drive or folder; schedule via `shell.reminders` or a systemd user timer |
| Password Manager | `passwords` | Encrypted vault (WebCrypto AES-GCM + Argon2/PBKDF2), generator, browser autofill hook |
| Cloud Drive | `cloud` | rclone-backed mounts (Google Drive, OneDrive, Nextcloud/WebDAV) shown in File Explorer |
| VPN / Network tools | `nettools` | NetworkManager VPN (WireGuard/OpenVPN import), ping/traceroute/DNS lookup/port check, speed test |

## Phase 4 — Extras

| App | id (planned) | Notes for later |
|---|---|---|
| Weather | `weather` | Open-Meteo (no API key), city search, hourly/daily; feeds the weather-based dynamic wallpaper and widgets |
| Maps | `maps` | OpenStreetMap tiles (Leaflet-like custom viewer), search via Nominatim, routes via OSRM |
| Contacts | `contacts` | vCard storage, shared with Mail autocomplete |
| Sticky Notes | `sticky` | Desktop sticky notes (always-on-top small windows), synced with Notes |
| Dictionary / Translator | `translate` | Offline dictionary (wordlists) + online translation provider (configurable) |
| Remote Desktop | `remote` | VNC/RDP client (noVNC-style in the shell, or FreeRDP in the image) |
