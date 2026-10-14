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
| Music | `music` | Lanceur alias of the Lecteur (no second player): Albums, Artistes, Titres (+ Genres), synced .lrc / embedded lyrics, shuffle all. MPRIS and global media keys added on 2026-10-14 (see below) |
| Code Editor | `code` | CodeMirror 6 (vendored bundle, tools/vendor-codemirror.mjs), folder tree with git status, tabs, find / replace, terminal panel (pty backend), branch in the status bar. Search across files, split view and diff added on 2026-10-14 (see below) |

The Video Editor was dropped at the user's request (DaVinci Resolve and the Flathub editors such as Kdenlive / Shotcut cover it).

## Phase 3 — System and connectivity (done, 2026-10-11)

| App | id | Notes |
|---|---|---|
| App Store | `store` | Curated catalog of command-line tools/services installed with APT through `aurora-admin` (allow-listed; tools shipped with the image cannot be removed). Since then: the whole Flathub and Ubuntu desktop catalogues, Flatpak updates view and install cancel (done 2026-10-13) |
| Disk Utility | `disks` | `lsblk`/`udisksctl`: drives, partitions, mount, eject; format removable drives only (`aurora-admin format-removable`); « Santé du disque » (SMART) added on 2026-10-14 |
| Backup | `backup` | rsync snapshots (`--link-dest`) of chosen home folders to a drive/folder, browse, restore, keep last N, reminders |
| Password Manager | `passwords` | Encrypted vault (WebCrypto AES-GCM + PBKDF2 600k), auto-lock, generator, CSV import/export (browser autofill dropped by the user, 2026-10-14) |
| Cloud Drive | `cloud` | **Light version:** Nextcloud/WebDAV browse, upload, download (Google Drive / OneDrive dropped by the user, 2026-10-14) |
| VPN / Network tools | `nettools` | **Light version:** NetworkManager VPN/WireGuard list, connect, WireGuard import; ping; DNS lookup. OpenVPN, traceroute, port check and speed test added on 2026-10-14 |

## Phase 4 — Extras (done, 2026-10-11)

| App | id | Notes |
|---|---|---|
| Weather | `weather` | Open-Meteo (no API key), city search, 24 h + 7-day forecast, saved places, °C/°F; sets the dynamic wallpaper location |
| Maps | `maps` | OpenStreetMap tiles in a custom viewer, Nominatim search, saved places. Routes (OSRM) added on 2026-10-14 |
| Contacts | `contacts` | JSON store, vCard 3.0/4.0 import/export, favourites, Mail recipient suggestions |
| Remote Desktop | `remote` | VNC client in the shell (TCP bridged by the main process). RDP (FreeRDP 3), VNC clipboard and more encodings added on 2026-10-14 |

Sticky Notes (`sticky`, « Mémos ») and Dictionary / Translator (`translate`) were removed at the user's request on 2026-10-14 (Notes covers the first; online translation sites in the Navigateur do better than the free MyMemory quota).

## Phase 5 — Everyday extras and accessibility (done, 2026-10-14)

| App / feature | id / module | Notes |
|---|---|---|
| Books (« Livres ») | `books` | EPUB reader, default for `.epub`: library (opened books + Documents / Téléchargements), table of contents, bookmarks, search, paginated or scrolled reading, text settings, reading themes; chapters shown in sandboxed frames without scripts |
| Scan (« Numérisation ») | `scan` | SANE (`scanimage` as the user, sane-airscan for driverless scanners): glass preview with a selection, feeder batches, colour / grey / black and white, 150–600 dpi, page strip, PDF / JPEG / PNG to Documents/Numérisations, « Envoyer par courriel ». Also a section in Paramètres > Imprimantes et scanners |
| System Logs (« Journaux système ») | `logs` | systemd journal (`journalctl`): presets (errors, previous boot, kernel, my apps), filters by boot / priority / source / text, live view, details, export; « Voir le journal » from the System Monitor's Services tab |
| Fonts (« Polices ») | `fonts` | Installed fonts by category, sample text and size, family page (styles, waterfall, character map), per-user install / removal (~/.local/share/fonts), opens `.ttf` / `.otf` from Fichiers |
| Help (« Aide ») | `help` | Offline help, about 70 articles in English and French, search, « Bien démarrer » tour offered at the first sign-in (`core/features/help-welcome.js`); article buttons open the right Paramètres page or app |
| Podcasts & News (« Podcasts et actus ») | `feeds` | RSS / Atom / RDF / JSON Feed reader and podcast player: subscriptions, OPML import / export, podcast search, downloads |
| Emoji and symbols panel | `core/features/emoji.js` | Super+. (or Super+;): emoji with skin tones, kaomoji, symbols (French typography, currencies, maths…), French and English search; types into Selene apps and Linux apps |
| Magnifier (« Loupe ») | `core/features/magnifier.js` | Full-screen zoom 100–1600 %, follows the pointer, the keyboard focus and the text caret, colour inversion, toolbar; Super+= / Super+- / Super+Échap; also works over Linux apps and on the lock screen |
| On-screen keyboard (« Clavier visuel ») | `core/features/osk.js` | Docked or floating, AZERTY / QWERTY / Swiss French layouts, sticky modifiers, types into Selene apps and Linux apps (XTest); Super+Ctrl+O; also on the sign-in screen |

Each one has its own test suite (`books`, `scan` + unit, `logs`, `fonts`, `help`, `feeds`, `emoji`, `magnifier`, `osk`).

## « Later » items of phases 2–4 (done, 2026-10-14)

Started in the phase 5 session, stopped half-way by the usage limit, then finished and tested the same evening.

| Item | App | What it does | Tests |
|---|---|---|---|
| Search across files, split view, diff | `code` | Ctrl+Shift+F search and replace in the folder (options, globs, .gitignore, cancel, confirmation + undo); Ctrl+\ split right / down, shared documents, layout per folder; diff with HEAD, the saved file or another file (`@codemirror/merge` vendored), side by side / inline, F7, revert a chunk | code.unit 29, code 111, code-extra 115 |
| Disk health (SMART) | `disks` | « Santé du disque »: Bon / Attention / Défaillance imminente / Inconnu with explanations, NVMe / SSD wear, SATA sector counts, detailed attributes, short / extended self-tests (udisks2 over D-Bus), smartctl read through `aurora-admin smart-info`, one notification per drive that gets worse (`core/features/disk-health.js`) | disks 68, disks-health 172 |
| OpenVPN, traceroute, port check, speed test | `nettools` | `.ovpn` import (opens from Fichiers) with a sign-in dialog (passwords never on a command line), traceroute (tracepath), port check + listening ports (`ss`), speed test against Cloudflare with history | nettools 105, nettools-extra 263 |
| Routes (OSRM) | `maps` | « Itinéraire »: start, up to 8 stops, destination, car / bike / foot, 2 alternatives, draggable markers, steps in English and French, copy / print / open in OpenStreetMap | maps 124, maps-routes 208 |
| RDP, VNC clipboard and encodings | `remote` | RDP through FreeRDP 3 in a Selene window (password on stdin, certificate fingerprint dialog, plain-language errors); VNC Hextile / ZRLE / Tight / Cursor and clipboard both ways | remote 135, remote-extra 149 |
| MPRIS and global media keys | `media`, `aurora-sessionbus` | The Lecteur on MPRIS, a media card in Réglages rapides for any MPRIS player, media keys everywhere with an OSD, the Podcasts folder left out of the music library | sessionbus 118, music 14, media 48 |

All of these were tested with fakes only (fake udisks / nmcli / FreeRDP / OSRM / MPRIS player, private D-Bus): real
hardware, a real Windows RDP server, a real OpenVPN server and real media players remain to be tried.

Dropped by the user on 2026-10-14: Google Drive / OneDrive in Cloud, password autofill in the Navigateur.
