# Aurora OS — project state

> **Resuming work? Read this file first** and continue from "Next steps". Do not restart the
> project: everything below already exists on branch `claude/focused-lamport-ogvj6v`.
> Keep this file updated after every milestone.

_Last updated: 2026-10-11 07:10 UTC (session 1, after usage-limit + weekly-limit interruptions)._

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
| 3. Core ISO + desktop | done — shell verified; ISO builds (≈800 MB, `make verify-iso` 104/104, `make smoke-image` OK); QEMU boot left to the user |
| 4. Required apps | browser, files, mail, paint, calculator, notepad, terminal, media, snipping, taskmgr, settings, 5 games — built; most verified (see table) |
| 5. Installer + QEMU instructions | done — installer app + aurora-install helper (92-check loop-disk install, BIOS+UEFI GRUB, autoinstall via `aurora.autoinstall=1`); docs/BUILDING.md (EN+FR) |
| **UI/UX personalization** (user request #2) | **in progress** — workflow `aurora-personalization`: core (theme engine, 5 visual styles, per-app themes, profiles, Theme designer) → wallpapers / taskbar+Start+focus / packs+shortcuts in parallel → verify → integration critic. Spec: see "Personalization request" below; settings schema in docs/PERSONALIZATION.md |
| **App phase 1** (PHASEAPP.md) | **in progress**: photos, calendar, clock, notes, todo, pdf, archive |
| App phases 2–4 | not started — see PHASEAPP.md |

### App / area status

| Area | Built | Independently verified |
|---|---|---|
| Shell UX (taskbar, Start, search, quick settings, calendar flyout, OSD, widgets, wallpapers, desktop) | ✅ | ✅ |
| Window mgmt (hotkeys, Alt+Tab, Task View + virtual desktops, snap layouts, Ctrl+Alt+Del, Run, Win+X) | ✅ | ✅ |
| Login screen, lock screen, welcome | ✅ | ✅ |
| System backends + Settings | ✅ | ✅ |
| Browser | ✅ | ✅ (66 tests) |
| File Explorer | ✅ | ✅ (272 checks) |
| Mail | ✅ | ✅ (44 steps, local IMAP/SMTP test server) |
| Paint, Calculator, Notepad, Terminal, Media Player, Snipping Tool | ✅ | ✅ (Paint 51, Calculator 672, Notepad 288, Terminal 244, Media 48, Snipping 40 checks) |
| Minesweeper, Snake, 2048, Solitaire, Chess, Task Manager | ✅ | ✅ |
| ISO build system | ✅ | ✅ static (no QEMU by user's choice) |
| Installer (app + aurora-install helper) | ✅ | ✅ (loop-device installs) |

## File structure

```
aurora-os/
  README.md  PHASEAPP.md  PROJECT_STATE.md  Makefile
  docs/BUILDING.md        build, QEMU run/install instructions (EN + FR)
  docs/DEVELOPING.md      architecture, app contract, UI kit, backend API, parallel-work rules
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
```

## Commands

```sh
sudo make iso                      # build out/aurora-os-<ver>-amd64.iso (needs root, Node 22, build tools)
make run | run-uefi | run-disk     # QEMU (user tests these; agent uses DRY_RUN=1 only)
make verify-iso                    # static ISO checks (no VM)
make smoke-image                   # run the image's shell + greeter under Xvfb (no VM)
cd shell && npm ci && npx electron . --dev --no-sandbox      # dev desktop
cd shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/smoke.mjs      # smoke test
cd shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/<area>.test.mjs
```

## Shared contracts added recently

- **`shell.reminders`** (core/reminders.js): shared alarm/reminder scheduler. Calendar, Clock and To Do use it.
- **Manifest `defaultFor`:** extensions an app opens by default (Photos for images, PDF Reader for `.pdf`).
- **`win.setMinSize(w, h)`.**
- **`ui.dialog`:** Enter respects the focused button.
- **`pdfjs-dist` 6.4.299:** dependency for the PDF Reader.

## Known issues / follow-ups

- Browser: after navigation the omnibox showed the placeholder instead of the URL in one screenshot (browser-page.png); the browser verify agent was told; re-check at integration.
- While apps are mid-build, missing icon.svg files log 404s at shell start; re-check that every app ships icon.svg at integration.
- Task Manager: killing several of another user's processes asks for admin once per PID (aurora-admin kill-process takes one PID).
- Solitaire auto-complete only offered when stock is empty and all cards face up.
- Sounds were never listened to (no audio device in the container).
- QEMU boot of the latest ISO is untested by the agent (user's choice). Proven only statically: live-session AppArmor fix (aurora-apparmor.service), GRUB theme/countdown, Secure Boot on installed disks, safe-graphics entry.
- Polkit: network/drive rights are for the sudo group only — standard users cannot mount internal partitions (no polkit password dialog yet).
- Build container leftovers: empty /cdrom and /usr/lib/aurora on the build host (mount points from an installer test; removal blocked by a safety check — harmless).
- ISO not bit-for-bit reproducible (grub-mkrescue date + volume UUID).
- docs/DEVELOPING.md API table should list the newer channels (proc:*, perf:*, net:*, audio:*, display:*, users:*, locale:*, admin:*, mail:*, pty:*, installer:*).

### Integration TODO (from QA reports — do in the integration pass)

- **SECURITY (drag and drop):** Files (`files/lib/dnd.js`), Notepad (`notepad/lib/window.js`) and Mail compose (`mail/lib/compose.js`) trust `application/x-aurora-paths` from ANY drag, including from web pages. Switch them to `trustedDragPaths(dataTransfer)` exported by `core/desktop.js`.
- **`shell.runAdmin`:** callers (Task Manager, installer) must handle the new error code ENOTADMIN (standard user) with a localized message.
- **Account pictures on the sign-in screen:** add `/var/lib/aurora/faces` (mode 1733) to `rootfs/usr/lib/tmpfiles.d/aurora.conf`, the ISO agent's file.
- **Greeter mode:** `main/index.js` loads every backend module, even mail, pty and fs. Restrict it to an allow-list of the modules the sign-in screen needs.
- **Wi-Fi key:** it is passed on the `nmcli` command line, so other local users can see it briefly in `/proc`. Consider a passwd-file approach.
- **Task Manager:** `kill-process` takes one PID at a time; a multi-PID admin action would avoid one UAC prompt per process.
- **Core CSS, after the personalization workflow** (its agents are editing tokens.css and ui.css now):
  - `.btn.danger` in dark mode is white on #ff99a4 (2:1 contrast).
  - `ui.menu` labels have no ellipsis (max-width 360 px, nowrap).
  - `.select:focus` hides the dropdown arrow.
  - `[data-animations="off"]` keeps infinite iterations, so spinners flicker. Add `animation-iteration-count: 1`.
- **wm:** optional Tab containment per window. Files and Mail already do it themselves.
- **fs.js:**
  - `fs:readText` should return the first maxBytes instead of throwing ETOOBIG.
  - `fs:copy` has no cancel.
  - `fs:trash` returns only a count.
- **Browser:**
  - Pop-ups are reopened as tabs, so `window.opener` doesn't work and some sign-in pop-ups may fail.
  - Real sites are blocked by the container proxy; only ubuntu.com was tested.
- **Mail:** no OAuth2; passwords are obfuscated, not encrypted (no keyring).
- **Fixed in session 1 by the coordinator:**
  - `ui.dialog`: focus moves into the dialog synchronously, goes back to the opener on close, Tab is trapped, Esc works with focus outside.
  - Core image clipboard (`clipboard:readImage` / `clipboard:writeImage`) works on Electron 44 (async ClipboardItem API).
  - File picker: no double extension (e.g. "photo.jpg.png"); "All files" works.
  - `registry.launch`: concurrent launches of a single-instance app share one window.
  - `notify({ image })`: preview picture in toasts.
  - `win.setAlwaysOnTop(bool)` and the `win.closed` getter.
- **Apps can now drop their workarounds:** Paint (`paint:clipboard*`), Snipping (`snipping:clipboard*`), Calculator (direct `win.opts` edits for keep-on-top), Snipping (toast image hack).
- **theme.js keeps a reference to the last window the pointer was over** (memory, one window). It belongs to the personalization owner; fix after that workflow.
  - net/audio status reads no longer suppress change pushes.
  - Oversized windows shrink after a resolution or scale change.
  - "1 byte" now has the right plural.
  - `ui.menu` no longer leaks a listener when closed in the same tick it opens.
  - French apostrophes in the core dictionary are now typographic (’).
  - `ui.dialog`: Enter respects the focused button.
  - `ui.menu`: captures keys immediately after opening.
  - Added `win.setMinSize`.

## Next steps (exact)

1. Wait for the running workflows (list at the bottom) to finish; commit after each.
2. **UI/UX personalization** (workflow `aurora-personalization`, running). If the session was lost mid-way:
   - Read docs/PERSONALIZATION.md and `git log`.
   - Check which areas exist: core/styles/, core/profiles.js, core/wallpaper/, core/features/focus.js, core/cursors.js, core/iconpacks.js, Settings pages `pages/personalization-*.js`.
   - Continue the missing ones with the same split:
     - A: core (theme engine, 5 visual styles, per-app themes, profiles, Theme designer).
     - B1: wallpapers (animated, dynamic by time/weather, lock screen).
     - B2: taskbar, Start, focus mode.
     - B3: cursor/icon/sound packs, snap presets, keyboard shortcuts.
     - Then verify each, then run an integration checklist against the request below.
3. Integration pass:
   - Full test sweep (every shell/test/*.test.mjs).
   - Fix cross-app issues; update DEVELOPING.md API table.
   - Rebuild the ISO (`sudo make iso`), run `make verify-iso` + `make smoke-image`.
   - Update README and this file.
4. Then wait for the user to request app Phase 2 (PHASEAPP.md).
   **Phase 2 mode (user decision, 2026-10-11):** extra usage on, ultracode OFF. Lean: one builder + one
   verifier per app, 2 apps at a time, time box per agent, key screenshots only, one `make test-all` at
   the end; small fixes done directly without agents.

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

## Interruption log

**2026-10-10 ~23:00 UTC:** the usage limit stopped several agents mid-task. State afterwards (all committed in e1132ab):

**Phase 1 apps**

| App | State | Still to do |
|---|---|---|
| photos | built (37 tests) | verify |
| pdf | built | verify |
| archive | built + verified | — |
| calendar | built (281 checks) | verify |
| clock | built + verified | — |
| todo | built | verify |
| notes | backend (`main/ipc/notes.js`) and pure libs done; UI (`apps/notes/ui/*`) partial | finish the build, then verify |

**Personalization**
- **Core (A):** built and verified. Style engine, 5 styles, profiles, Theme designer, app themes, `docs/PERSONALIZATION.md`.
- **B2 (taskbar/Start/focus) and B3 (packs/shortcuts):** their builders failed. The integration agent then implemented them:
  - taskbar size, position, labels and auto-hide;
  - Start layouts, folders and background;
  - focus mode (`core/features/focus.js`);
  - cursor/icon/sound packs (`core/packs.js`, `sounds.js`);
  - snap presets and customizable shortcuts (`core/shortcuts.js`, `hotkeys.js`);
  - Settings pages `personalization-{taskbar,focus,packs,input}.js`;
  - test `personalization-shell.test.mjs`.

  These are **not independently verified yet**.
- **B1 (wallpapers):** partially built. `core/wallpaper/{engine,dynamic,solar,cities,lock}.js` + `effects/`, `features/wallpaper.js`, `main/ipc/weather.js`, `assets/wallpapers/dynamic/`, `test/wallpapers.test.mjs`. Needs finishing, then verify.
- **Integration agent:** stopped during the regression sweep and docs update. **Rerun it at the end.**

**Media test:** "files opened while the window is still starting" failed once in a full run under heavy load, then passed alone. Recheck in the final sweep.

## Second interruption (weekly limit, 2026-10-11 ~02:00 UTC) — state at 07:10 UTC (commit f0cc7af)

**Finished since the first interruption**
- notes: built.
- photos: verified.
- clock: re-verified.
- B2 (taskbar, Start, focus mode): verified. 257 checks in `test/taskbar-start-focus.test.mjs`.

**Cut mid-way, now relaunched**
- Verification of calendar, pdf, archive (second pass), todo and notes.
- B1: wallpapers finish + verify.
- B3: packs/shortcuts verify.
- Personalization integration checklist.

The shell smoke test passes on f0cc7af. Workflows were resumed at 07:10 UTC (resumeFromRunId, cached successes reused).

## Speed-up restructure (2026-10-11 ~08:00 UTC, user asked to cut the 4-5 h estimate)

Cause of the slowness: 4 CPUs, so each workflow runs only 2 agents at a time, and personalization ran
verify:wallpapers then a long integration agent one after the other (plus a redundant B2 re-check).

- `aurora-personalization-finish` was **stopped**. Kept: finish:wallpapers report and the first B2 verify
  report (saved in the session scratchpad `handoff/`). Its file edits are all on disk.
- Replaced by `aurora-personalization-final` (`.claude/wf-scripts/aurora-personalization-final.js`), 2 agents in parallel:
  - **W**: verify wallpapers + theme designer / 5 styles / typography / per-app themes / profiles; theme.js last-window leak.
  - **S**: finish B3 (packs, shortcuts, snap presets) + re-confirm B2 + combination stress + core/ui.css fixes
    (`.btn.danger` contrast, menu ellipsis, `.select:focus` arrow, animations-off iteration count).
- New `aurora-integration-todo` (2 agents, files nobody else owns):
  - **T1**: trusted drag paths in Files/Notepad/Mail/Media, ENOTADMIN in Task Manager + installer, `/var/lib/aurora/faces` tmpfiles.
  - **T2**: DEVELOPING.md API table, README (phase-1 apps + Personalization section), browser omnibox check, app icons.
- `aurora-apps-phase1-a`: photos, pdf, archive verified (reports in the scratchpad `handoff/phase1a-reports.json`).
  Its Notes verifier was stopped at 08:25 UTC (before editing anything) and replaced by `aurora-notes-fast`
  (2 agents: N-UI = apps/notes/ui + notes.test.mjs incl. trustedDragPaths; N-CORE = lib/ + main/ipc/notes.js + new notes.unit.mjs).
- `aurora-apps-phase1-b`: calendar verified; todo finishing.
- Done at ~08:20 UTC: agent W (wallpapers/theme) and T1 (drag trust, ENOTADMIN, faces dir). PDF Reader drag trust fixed by the coordinator.
- Agents are told: no full regression sweep (the coordinator runs it once at the end), time box ~60-75 min.
- ISO package layer pre-built (`./iso/build.sh --until packages`, up to date at 07:57 UTC); the final build only needs `--from system`.
- New `make test-all` (`shell/test/run-all.mjs -j N --retry`) runs every suite with a summary.

**Final pass when all four workflows are done:**
1. Commit. Then `cd shell && node test/run-all.mjs -j 3 --retry`; fix real failures (agents per failing area).
2. Check that N-UI switched Notes to `trustedDragPaths` (PDF is done).
3. `./iso/build.sh --from system` (re-run `--until packages` first if iso/packages.d changed), then `make verify-iso` and `make smoke-image`. Never QEMU.
4. Update PHASEAPP.md (phase 1 done), README, this file; commit and push.

## Running workflows (resumed 2026-10-11 ~01:00 UTC; see the restructure above for the current list)

- `aurora-apps-phase1-a`: notes build (continuing the partial files) and verification of photos, pdf and notes.
- `aurora-apps-phase1-b`: verification of calendar and todo.
- `aurora-personalization-finish`: finish the wallpapers and verify them; verify B2 and B3; then the integration checklist, regression sweep and docs.

If these die too, recheck the state with `git log`, the files listed above, and `node test/<area>.test.mjs`. Then continue the same steps.

