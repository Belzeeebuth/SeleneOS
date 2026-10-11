# Linux applications in Selene Shell (external X11 windows)

Selene Shell is one fullscreen Electron window, and every built-in app is a DOM window inside it.
Regular Linux GUI programs (GIMP, LibreOffice, VLC, Inkscape, xterm…) are separate X11 clients. This
document describes how they are shown and managed inside the shell.

## Principle

1. **`aurora-xwm`** (`rootfs/usr/lib/aurora/helpers/aurora-xwm`, python3 + python3-xlib) is a small
   X11 window manager:
   - It takes `SubstructureRedirect` on the root window and never reparents.
   - Every client top-level is kept **below** the shell window.
   - It talks to the shell's main process with JSON lines over stdin/stdout.
2. **The shell draws the frame.** Each external client gets a normal DOM window from `core/wm.js`:
   title bar, icon, buttons, taskbar entry, Alt+Tab, snap, minimise and maximise. The frame's content
   area is left empty.
3. **The shell window is cut where clients show.** The shell window gets an X Shape
   (`BrowserWindow.setShape`): the screen minus the visible part of each external content area.
   - The X server shows the client through that hole and sends it the clicks and wheel events there.
     Input passes through because the input shape defaults to the bounding shape.
   - A DOM element that must be above a client (taskbar, Start, flyouts, menus, toasts, another DOM
     window higher in the stack, the lock screen…) is not cut, so it covers the client.
4. Override-redirect windows (client menus, tooltips, combo-box popups) are mapped on top by the X
   server, above the shell, as expected.

The prototype under Xvfb verified the following:
- holes are drawn and receive input;
- clicking a client focuses it (button grab plus `ReplayPointer`), and typing reaches it;
- clicking the shell gives the keyboard back to Chromium, even with EWMH advertised;
- passive key grabs on the root (Super, Alt+Tab) work while a client has focus;
- xterm's override-redirect menu shows above the shell.

## Processes

- The main process module `shell/main/ipc/xwin.js` starts the helper:
  `aurora-xwm --shell-xid <XID>`, using `helperPath('aurora-xwm')` and `DISPLAY` from the
  environment. `<XID>` comes from `mainWindow.getNativeWindowHandle()`.
- It starts only in shell mode (never in the greeter), on Linux, and when the helper exists. In dev and
  tests it starts only when `AURORA_XWM=1`, so other suites are unaffected.
- The helper exits when its stdin closes. The main process restarts it at most 3 times within a
  minute. If it exits with status 3 (another WM is running) or 4 (python3-xlib is missing), it is
  not restarted.
- Linux applications are launched by the main process (`xapps:launch`). It spawns them detached,
  with `DISPLAY`, `GTK_THEME` and `QT_QPA_PLATFORMTHEME` as described below, outside the Electron
  process group.

## Coordinates

- The helper works in root-window device pixels; the renderer works in CSS pixels.
- `xwin.js` converts between them:
  `device = (css × webContents zoom factor) × display scaleFactor + shell window content origin`.
- In production the origin is (0,0) and both factors are usually 1. In dev the window can be
  anywhere.

## Protocol (one JSON object per line, UTF-8, both directions)

### Helper → main: events (`"ev"`)

| Event | Fields | Meaning |
|---|---|---|
| `ready` | `screen:{width,height}`, `version` | Managing; existing clients follow as `new`. |
| `fatal` | `code` (`EOTHERWM`, `ENOXLIB`, `ENODISPLAY`), `message` | Followed by exit 3, 4 or 1. |
| `new` | `id` (XID number), `title`, `wmClass:[instance,class]`, `pid` (or null), `type` (`normal`, `dialog`, `utility`, `splash`, `toolbar`), `transientFor` (XID or null), `modal`, `x`, `y`, `width`, `height` (requested), `minWidth`, `minHeight`, `maxWidth`, `maxHeight` (0 if none), `decorated` (false when Motif hints say no decorations; the client draws its own title bar, as GTK header bars do), `fullscreen`, `icon` (`data:image/png;base64,…` built from `_NET_WM_ICON`, size closest to 32, or null), `startupId`, `gtkAppId` (`_GTK_APPLICATION_ID` or null) | A client top-level asked to be mapped. The helper has mapped it below the shell at the requested geometry. It is not visible until the shell cuts a hole. |
| `title` | `id`, `title` | `_NET_WM_NAME` / `WM_NAME` changed. |
| `icon` | `id`, `icon` | `_NET_WM_ICON` changed. |
| `hints` | `id`, `minWidth`, `minHeight`, `maxWidth`, `maxHeight`, `decorated` | `WM_NORMAL_HINTS` or Motif hints changed. |
| `configure-request` | `id`, plus any of `x`, `y`, `width`, `height` | The client wants another geometry. The shell decides and answers with `place`. |
| `state-request` | `id`, `fullscreen` (true/false), or `maximized`, or `minimized: true`, or `activate: true` | `_NET_WM_STATE`, `WM_CHANGE_STATE` or `_NET_ACTIVE_WINDOW` from a client. |
| `drag` | `id`, `x`, `y`, `width`, `height`, `done` (bool) | Interactive move or resize that the helper runs itself (`_NET_WM_MOVERESIZE` from a client-side title bar; Alt+drag is not implemented yet). The shell moves the frame to follow, without sending `place` back during the drag. |
| `focus` | `id` (XID, or null when the shell or nothing has focus) | X input focus changed. |
| `click` | `id` | A button press reached a client. The helper has already focused it and replayed the click. The shell raises the frame. |
| `key` | `combo`, `repeat` | A grabbed system shortcut while a client has focus. Same names as `shell/main/lib/hotkeys.js` (`Super`, `Alt+Tab`, `Alt+Shift+Tab`, `Alt+F4`, `Super+D`, `AudioVolumeUp`…), plus `Alt:up`. |
| `gone` | `id` | Withdrawn (unmapped by the client) or destroyed. |
| `pong` | `seq` | Reply to `ping`. |
| `log` | `level`, `message` | Diagnostics for the journal. |

### Main → helper: commands (`"cmd"`)

| Command | Fields | Effect |
|---|---|---|
| `place` | `id`, `x`, `y`, `width`, `height` | Move and resize the client content (device px). If nothing changes, a synthetic ConfigureNotify is sent (ICCCM). |
| `stack` | `ids` (bottom → top) | Restack the managed clients, all kept just below the shell window. |
| `focus` | `id` (XID, or null for the shell) | `XSetInputFocus` (plus `WM_TAKE_FOCUS` when the client supports it); `_NET_ACTIVE_WINDOW` on the root is updated. |
| `close` | `id` | `WM_DELETE_WINDOW` if supported, else `XKillClient`. |
| `kill` | `id` | `XKillClient`; the shell's "End task" uses it. |
| `state` | `id`, `fullscreen`, `maximized`, `minimized` | Keep `_NET_WM_STATE` and `WM_STATE` in step with the frame. A minimised client stays mapped: without a hole it is simply hidden behind the shell. |
| `ping` | `seq` | Answered with `pong`. |

Rules:
- IDs are XIDs as JSON numbers.
- Unknown fields are ignored, and a malformed line is logged and ignored.
- The helper never exits on an X error from a client (`BadWindow` races are normal).

### Keyboard

- While a client has X focus, the helper holds passive grabs on the root for the system shortcuts:
  - every `Super` combo, and `Super` alone, which is sent on release when no other key was pressed;
  - `Alt+Tab`, `Alt+Shift+Tab`, `Alt+F4`, `Ctrl+Alt+Delete`, `Ctrl+Shift+Escape`;
  - `PrintScreen` and the volume and brightness keys.

  It releases them while the shell has focus, because Chromium's own handling (`hotkeys.js`) applies
  then.
- For `Alt+Tab`, `Alt+Shift+Tab`, `Super` and `Super+Tab`, the helper moves X focus to the shell
  **before** sending the event, so that the Alt release reaches the shell's page and commits the
  switcher. For the other combos, focus is unchanged.
- The main process broadcasts these events exactly like `hotkeys.js` (`shell:hotkey`).
- Rule in the renderer: whenever the DOM focus moves into shell UI (Start, flyouts, a DOM window,
  dialogs) while a client has X focus, the renderer sends `focus null`. When an external frame
  becomes the focused `wm` window, it sends `focus <id>`.

### Shape

- The renderer computes the holes and sends `xwin:shape` (a list of CSS rects):
  `hole(W) = contentRect(W) − ⋃ rect(every visible element above W)`, where W is each visible,
  non-minimised external window on the current desktop.
- Main converts the holes and sets `setShape(screen − holes)`. With no holes it sets the full window
  rectangle (`setShape([])` does not give the area back on X11: the old hole kept showing the client),
  then calls `webContents.invalidate()` so that areas given back to the shell are repainted. A window
  that was never shaped is left alone, and the shape is rebuilt when the window is resized.
- The holes are recomputed:
  - on every wm change (move, resize, focus, stack, minimise, desktop switch);
  - on flyout, menu and toast changes;
  - at least every 250 ms while a client is visible (cheap: a few `getBoundingClientRect` calls);
  - every animation frame during drags.
- When nothing changes, nothing is sent.

## Desktop entries (Start menu and search)

- The main process module `shell/main/ipc/xapps.js` parses the `.desktop` files in
  `/usr/share/applications`, `/usr/local/share/applications` and
  `~/.local/share/applications`. It also reads `/var/lib/flatpak/exports/share/applications`
  when present.
- It skips entries with `NoDisplay=true`, `Hidden=true`, `Type≠Application`, or a non-matching
  `OnlyShowIn`/`NotShowIn` (Selene counts as `Selene` and `X-Selene`).
- `Terminal=true` entries are skipped as well.
- Names are localised (`Name[fr]`).
- Icons are resolved in the hicolor or Adwaita theme, then `/usr/share/pixmaps`, preferring SVG or
  48 px PNG. They are served as `media://` URLs, which `img-src` already allows.
- Entries are merged into the registry as apps with `kind: "linux"`, so they appear in Start "All
  apps", search and pins.
- Launching uses `Exec` with the field codes `%f %F %u %U %i %c %k` handled, and no shell
  interpretation.
- The window is matched to the entry by `StartupWMClass`, else `gtkAppId`, else the WM class against
  the desktop file name, else the launched pid. The match gives the taskbar its icon and grouping.
- The directories are watched, so newly installed apps appear without restarting.

## Theme

GTK and Qt applications follow the shell's light or dark mode for the windows they open:
- `~/.config/gtk-3.0/settings.ini` and `~/.config/gtk-4.0/settings.ini` get
  `gtk-application-prefer-dark-theme`;
- `GTK_THEME=Adwaita` or `Adwaita:dark` is set when launching.

## Tests

- `shell/test/xwm-helper.test.mjs` drives the helper directly under Xvfb with xterm and xeyes clients,
  without Electron.
- `shell/test/xwin.test.mjs` runs the dev shell with `AURORA_XWM=1`. It opens xterm, then checks the
  hole pixels, typing, the taskbar entry, minimise and restore, close, and Start menu stacking above
  the client.
- `shell/test/xapps.test.mjs` uses fixture `.desktop` files (`AURORA_XAPPS_DIRS`) for parsing,
  icons, the Start entries and launch argument building.
