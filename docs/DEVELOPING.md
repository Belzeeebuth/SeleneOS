# Selene OS developer guide

Selene OS is Ubuntu 24.04 with a custom desktop. The desktop ("Selene Shell") is one fullscreen
Electron app that draws the wallpaper, taskbar, Start menu and **all windows** itself. Every
built-in app is an ES module loaded into that shell. System access goes through a small IPC API
in the Electron main process.

```
aurora-os/
  shell/                    Electron app (desktop shell, login screen, all apps)
    main/index.js           main process bootstrap (modes: shell | greeter)
    main/lib/               ipc framework, protocols (app://, media://), hotkeys, exec helpers
    main/ipc/*.js           backend modules, auto-loaded (one file per area: fs, sys, settings, net…)
    preload/preload.js      window.aurora bridge
    renderer/shell.html     desktop entry      renderer/greeter.html   login screen entry
    renderer/core/          shell core: wm, taskbar, start, desktop, ui kit, i18n, theme…
    renderer/core/features/ optional shell features, auto-discovered (export mount(ctx))
    renderer/apps/<id>/     one folder per app (manifest.json, main.js, style.css, i18n.json, icon.svg)
    renderer/assets/        icons (Phosphor, MIT), wallpapers, logos
    test/lib.mjs            Playwright/Electron harness;  test/smoke.mjs
  rootfs/                   files copied verbatim into the OS image (/etc, /usr/lib/aurora, …)
  iso/                      ISO build scripts;  iso/packages.d/*.list = apt packages per feature
  tools/                    QEMU helpers
```

## Running the shell during development

```sh
cd aurora-os/shell
npm install
npx electron . --dev --no-sandbox                 # windowed desktop (needs an X display)
xvfb-run -a -s "-screen 0 1600x900x24" node test/smoke.mjs --lang=fr --theme=dark
node test/run-all.mjs -j 2 --retry          # every suite (= make test-all), summary + logs in test/out/logs/
```

`--open=calculator,files` launches apps at startup; `--mode=greeter` shows the login screen.
Screenshots from tests land in `shell/test/out/`.

A test script looks like this:

```js
import { launchShell } from '../../test/lib.mjs';   // path relative to your test file
const s = await launchShell({ open: ['calculator'], lang: 'fr', theme: 'dark' });
await s.page.click('.app-calculator button[data-key="7"]');
console.log(await s.aurora(() => window.__aurora.wm.list().map((w) => w.title)));
await s.shot('calculator-fr-dark');   // -> shell/test/out/calculator-fr-dark.png
await s.close();
```

`window.__aurora` exposes `{ wm, registry, shell, settings, i18n, notify, taskbar, start, … }`.
Each launch gets a throwaway `$HOME`, so tests never touch real data.

## Writing an app

`renderer/apps/<id>/manifest.json` (see the header of `core/registry.js` for every field):

```json
{
  "id": "calculator",
  "name": { "en": "Calculator", "fr": "Calculatrice" },
  "icon": "icon.svg", "entry": "main.js", "styles": ["style.css"],
  "window": { "width": 360, "height": 560, "minWidth": 320, "minHeight": 480, "background": "mica" },
  "category": "utilities",
  "keywords": { "en": ["math"], "fr": ["calcul"] },
  "fileTypes": []
}
```

`fileTypes` lists the extensions the app can open (it gets `ctx.args.file`). `defaultFor` lists the ones it
opens by default: it beats apps that only list them in `fileTypes`, and the user's choice in Settings
(`settings.defaultApps`) beats both. Other fields: `singleInstance` (a relaunch focuses the window and calls
`onRelaunch`), `hidden` (not in Start), `liveOnly` (live session only).

`main.js`:

```js
export default {
  async launch(ctx) {
    const { win, h, icon, ui, t, api, shell, storage } = ctx;
    win.body.appendChild(h('div', { class: 'my-app' }, t('hello')));
    win.onBeforeClose(async () => true);            // return false to cancel closing
    return { onRelaunch(args) {} };                 // for singleInstance apps
  },
};
```

What you can use:

- **`ctx.win`** (window): `body`, `titlebarSlot` (for tabs in a `"titlebar": "tall"` window), `setTitle`,
  `setIcon`, `close`, `minimize`, `maximize`, `focus`, `setSize`, `setFullscreen`, `setProgress`, `flash`,
  `setMinSize(w, h)` (grows the window if needed), `setAlwaysOnTop(bool)`, `closed` (true once closed: check
  it after an `await`), `onBeforeClose`, `on('resize'|'focus'|'blur'|'close'|…)`. All windows get the title
  bar, controls, resize handles, snapping and animations for free (full list in the header of `core/wm.js`).
- **`ctx.ui`** (UI kit): `menu`, `dialog`, `alert`, `confirm`, `prompt`, `filePicker`, `toggle`, `slider`,
  `select`, `segmented`, `fileIcon`, `loadCss(href)` (adds a stylesheet once). **`ctx.h`** builds DOM;
  **`ctx.icon(name)`** draws a Phosphor icon (Phosphor names, or the older Fluent-style names kept as
  aliases; see [design/SYSTEM.md](design/SYSTEM.md) §8). Check that a name exists with
  `node -e 'const j=require("./renderer/assets/icons/phosphor.json");console.log([...Object.keys(j.glyphs),...Object.keys(j.aliases)].filter(k=>k.includes("arrow")).join(" "))'`.
- **`ctx.t(key, vars)`**: looks in `apps/<id>/i18n.json` (`{ "en": {…}, "fr": {…} }`), then in the core
  dictionary (`common.ok`, `common.cancel`, `common.save`, …). Plurals use the `key_one` / `key_other`
  forms with `{ count }`. **Every visible string must exist in English and French.**
- **`ctx.shell`** (shell services, `core/services.js`): `launch(appId, args)`, `openFile(path, {appId})`,
  `openUrl(url)`, `notify(…)`, `runAdmin(action, args, {reason, appId})` (shows a UAC prompt; throws
  `ECANCELED` if dismissed, `ENOTADMIN` for a standard user), `reminders` (below), `clipboard.setFiles/getFiles`,
  `xdg` (user folders), `sounds.play(name | tonePattern)`, `lock()`, `logout()`, `shutdown()`, `reboot()`,
  `suspend()`, `on('lock'|'unlock'|'files-clipboard', fn)`.
- **`shell.notify({ title, body, icon, image, appId, actions: [{label, onClick}], onClick, timeout, silent, urgent })`**
  (`core/notify.js`): `image` is a preview picture (`app:`, `media:`, `blob:` or `data:` URL); `urgent: true`
  still shows the toast with Do not disturb or Focus mode on (alarms and timers only).
- **`shell.reminders`** (`core/reminders.js`): one scheduler for alarms, reminders and events that fires
  while the app is closed. `set({ id, appId, at, title, body, repeat, kind: 'reminder'|'alarm', snoozeMinutes,
  sound, data })`, `remove(id, appId)`, `get(id, appId)`, `list(appId)`, `snooze(id, appId, min)`,
  `on('fire'|'change', fn)`. `repeat`: `null`, `'daily'`, `'weekdays'`, `'weekly'` or `{ days: [0..6] }`.
  Clicking the notification launches the app with `{ reminder: { id, data } }`. Missed reminders fire at the
  next start if under 6 hours late. Used by Clock, To Do and Calendar.
- **`ctx.storage`**: `get(name, fallback)`, `set(name, value)`, `delete(name)`: per-app JSON in `~/.config/aurora/apps/<id>/`.
- **`ctx.api.invoke(channel, …args)`**: the backend (list below). `ctx.api.on(channel, fn)` receives its
  events, `ctx.api.send(channel, …args)` is fire-and-forget. `ctx.api.mediaUrl(path)` turns a local
  file into a URL for `<img>`, `<video>` and `<audio>`, with seeking support.
- **`ctx.settings`**: `get('theme')`, `on('theme', fn)`.
- **`ctx.i18n.extend({ en: {…}, fr: {…} })`** adds strings to the core dictionary (core features use it).
- **Personalization** (visual styles, per-app themes, `effectiveTheme(el)` for canvas apps, theme events,
  wallpaper, taskbar/Start, packs, shortcuts, profiles, settings keys): see
  [PERSONALIZATION.md](PERSONALIZATION.md). Apps that follow the tokens and `:root[data-theme="dark"] .app-x`
  selectors need no extra work.

### Visual rules (Selene design system)

The full reference is [design/SYSTEM.md](design/SYSTEM.md) (styles, ambiances, accents, tokens, icons).

- Use the CSS tokens from `core/tokens.css` (`--text`, `--text-2`, `--card`, `--stroke`, `--accent`,
  `--subtle-hover`, radii, `--ease`, durations) and the classes from `core/ui.css` (`.btn`, `.btn.primary`,
  `.btn.subtle`, `.input`, `.select`, `.toggle`, `.slider`, `.card`, `.card-row`, `.list-item`, `.nav-item`,
  `.toolbar`, `.tabs`, `.segmented`, `.infobar`, `.empty`, typography classes).
- No hex colours in components: tokens only, so the three styles (Nocturne, Éclipse, Clair de lune),
  Contraste élevé, the ambiances and the accents all work. Per-style differences go through the style
  hooks (`--bar-mode`, `--win-border`, `--sel-bar-w`, `--panel-grain`…), not through `[data-style]` selectors
  in app CSS. Test **light + dark** and **en + fr**.
- Blur (`backdrop-filter`) only on the bar, the Lanceur and shell panels, never in app windows.
- Fonts: Manrope for titles, Inter for text (14px body, 12px captions). Radii come from the tokens.
- Animate with `transform`/`opacity` only, using `var(--ease)`; respect `[data-animations="off"]`.
- Scope your CSS under `.app-<id>` (the window gets that class) so apps never clash.

### Backend API (`api.invoke`)

One file per area in `main/ipc/`, the source of truth: each file's header documents arguments and results.
`(+x)` is an event the renderer receives with `api.on('x', fn)`; progress and watch events go only to the
window that asked. In greeter mode (`--mode=greeter`) only `settings`, `sys`, `greetd`, `net` and
`power-ext` are loaded.

| Area (file) | Channels |
|---|---|
| files (`fs.js`) | `fs:home` `fs:xdg` `fs:list` `fs:stat` `fs:exists` `fs:readText` `fs:writeText` `fs:readBytes` `fs:writeBytes` `fs:mkdir` `fs:uniqueName` `fs:rename` `fs:copy` (+`fs:progress`) `fs:trash` `fs:trashList` `fs:trashRestore` `fs:trashEmpty` (+`fs:trash-changed`) `fs:delete` `fs:search` `fs:watch`/`fs:unwatch` (+`fs:changed`) `fs:drives` `fs:mount` `fs:unmount` `fs:eject` `fs:usage` `fs:dirSize` |
| Files (`files.js`) | `files:transfer` (+`files:progress`) `files:cancel` `files:dirStats` (+`files:dirStats`) `files:props` `files:chmod` `files:compress` `files:extract` `files:head` `files:thumb` `files:media` `files:recent` `files:mounts` `files:drivesWatch` (+`files:drives-changed`) |
| system (`sys.js`, `power-ext.js`) | `sys:info` `sys:stats` `power:shutdown` `power:reboot` `power:suspend` `power:battery` (+`power:changed`) `session:logout` `apps:list` |
| shell (`sys.js`) | `shell:zoom` `shell:capture(rect)` `shell:screenSize` `shell:features` `shell:devtools` `clipboard:readText` `clipboard:writeText` `clipboard:readImage` `clipboard:writeImage`; `hotkeys:rules` `hotkeys:setCustom` (`main/lib/hotkeys.js`, custom shortcuts); events from `main/`: `shell:hotkey` `shell:open-url` `shell:open-mailto` |
| settings (`settings.js`) | `settings:all` `settings:get` `settings:set` `settings:setMany` `settings:defaults` `settings:reset` (+`settings:changed`), `storage:get` `storage:set` `storage:delete` `storage:dir` |
| admin (`admin.js`) | `admin:needsPassword` `admin:status` `admin:securityStatus` `admin:run(password, action, args)` (+`admin:progress` `admin:devChanged`) — apps use `shell.runAdmin` |
| auth, users (`auth.js`, `users.js`) | `auth:status` `auth:verify` `auth:setLocked` `auth:idle` (+`auth:suspend`), `users:list` `users:current` `users:changePassword` `users:setPicture` `users:removePicture` (+`users:changed`) |
| net (`net.js`) | `net:status` `net:details` `net:usage` `net:known` `net:setWifi` `net:setAirplane` `net:wifiList` `net:wifiConnect` `net:wifiDisconnect` `net:wifiForget` (+`net:changed`) |
| audio (`audio.js`) | `audio:status` `audio:setVolume` `audio:setMuted` `audio:setOutput` `audio:setInput` `audio:setInputVolume` `audio:setInputMuted` (+`audio:changed`) |
| display (`display.js`) | `display:status` `display:setMode` `display:setBrightness` `display:save` `display:saved` `display:applySaved` (+`display:changed`) |
| locale, input (`locale.js`) | `locale:status` `locale:timezones` `locale:setKeyboard` `input:mouse` `input:setMouse` |
| greetd (`greetd.js`, login screen) | `greeter:info` `greeter:users` `greeter:login` `greeter:power` `greeter:keyboard` `greeter:setKeyboard` `greeter:a11y` `greeter:setA11y` `session:welcome` |
| installer (`installer.js`) | `installer:disks` `installer:keyboards` `installer:timezones` `installer:applyKeyboard` `installer:start` `installer:status` `installer:cancel` `installer:log` `installer:reboot` (+`installer:progress`) |
| processes (`taskmgr.js`) | `proc:list` `proc:info` `proc:alive` `proc:kill` `proc:killTree` `proc:setPriority` `proc:spawn` `proc:shell` `perf:snapshot` `perf:users` `perf:services` `perf:startup` `perf:startupSet` |
| pty (`pty.js`, Terminal) | `pty:spawn` `pty:resize` `pty:signal` `pty:kill` `pty:info` `pty:env` `pty:fonts` `pty:primaryRead` `pty:primaryWrite`, `api.send('pty:write')` `api.send('pty:ack')` (+`pty:data` `pty:proc` `pty:exit`) |
| browser (`browser.js`) | `browser:initPartition` `browser:disposePartition` `browser:setPrefs` `browser:info` `browser:favicon` `browser:navHistory` `browser:inspect` `browser:copyImageAt` `browser:clearData` `browser:sitePermissions` `browser:resetSitePermissions` `browser:permissionReply` `browser:authReply` `browser:jsDialogReply` `browser:downloads` `browser:downloadUrl` `browser:downloadPause` `browser:downloadResume` `browser:downloadCancel` (+`browser:open` `browser:download` `browser:permission` `browser:permission-done` `browser:auth` `browser:auth-done` `browser:js-dialog` `browser:js-dialog-done` `browser:context-menu` `browser:shortcut` `browser:external` `browser:popup-blocked`) |
| mail (`mail.js`) | `mail:presets` `mail:autodetect` `mail:storage` `mail:accounts` `mail:testAccount` `mail:addAccount` `mail:updateAccount` `mail:removeAccount` `mail:folders` `mail:list` `mail:message` `mail:attachment` `mail:parseFile` `mail:setFlags` `mail:move` `mail:archive` `mail:delete` `mail:emptyFolder` `mail:markAllRead` `mail:tempDir` `mail:send` `mail:saveDraft` `mail:source` `mail:saveSource` `mail:watch` `mail:status` (+`mail:changed` `mail:new` `mail:status`) |
| photos (`photos.js`) | `photos:scan` `photos:items` `photos:meta` `photos:folder` `photos:thumbDir` `photos:thumbPut` `photos:rotate` `photos:write` `photos:copyFile` `photos:watch`/`photos:unwatch` (+`photos:changed`) |
| notes (`notes.js`) | `notes:root` `notes:open` `notes:writeIndex` `notes:writeNote` `notes:remove` `notes:duplicate` `notes:attach` `notes:dataUrl` `notes:exportAssets` `notes:gc` `notes:clipboard` `notes:clipboardWriteImage` |
| archive (`archive.js`) | `archive:tools` `archive:list` `archive:preview` `archive:test` `archive:extract` `archive:extractTemp` `archive:create` `archive:add` `archive:delete` `archive:cancel` `archive:tempDir` `archive:cleanup` (+`archive:progress`) |
| pdf (`pdf.js`) | `pdf:save(path, bytes)` |
| weather (`weather.js`) | `weather:current(place?, { force })` `weather:search(query, { lang, count })` `weather:stats` (+`weather:changed`) — Open-Meteo, cached 30 min, offline fallback; see docs/PERSONALIZATION.md §9.4 |
| app helpers | `notepad:fonts` `paint:fonts`; legacy `paint:clipboard*Image` and `snipping:clipboard*Image` (new code uses `clipboard:*Image`) |

New backend areas go in a **new file** `main/ipc/<area>.js`:

```js
module.exports = function register(api) {
  api.handle('net:list', async () => { … });     // throw api.error('msg', 'CODE') on failure
  api.broadcast('net:changed', payload);         // to every shell window
  api.on('pty:write', (id, data, event) => …);   // fire-and-forget from aurora.send()
};
```

Use `require('../lib/exec')` → `run(cmd, args)`, `sudoRun(password, helper, args)`, `helperPath(name)`.
When a system tool is missing (as on a dev machine), return sensible empty or mock data
when `api.DEV` is true. Never let it throw unhandled.

Privileged actions go through `admin:run(password, action, args)`, which runs
`/usr/lib/aurora/helpers/aurora-admin <action> …` through sudo. The helper is an allow-list of
actions. Never expose a generic "run this command as root" path.

## Built-in apps (`renderer/apps/<id>/`)

Tests live in `shell/test/<id>.test.mjs`; Minesweeper, Snake and 2048 share `games-classic.test.mjs`,
Settings uses `system-settings.test.mjs`.

- `archive` - Archives: open, extract and create ZIP, 7z, RAR and TAR archives
- `backup` - Backup: incremental rsync snapshots of your folders to a drive; browse and restore
- `browser` - Browser: Chromium `<webview>` tabs, favorites, history, downloads, private windows
- `calculator` - Calculator: standard, scientific, programmer, date calculation, unit converters
- `calendar` - Calendar: month/week/day/agenda views, recurring events, reminders, holidays, .ics import/export
- `camera` - Camera: webcam photos (JPEG) and videos (WebM VP9/Opus), timer, grid, mirror; Pictures/Camera Roll (`camera.js` backend streams recordings to disk and writes their duration)
- `chess` - Chess against the computer or a friend
- `clock` - Clock: alarms, timers, stopwatch, world clock, focus sessions
- `cloud` - Cloud: browse, upload and download Nextcloud / WebDAV files (other services later)
- `contacts` - Contacts: people, e-mails, phones, addresses, birthdays, vCard import/export; feeds Mail's recipient suggestions
- `disks` - Disks: drives and partitions, mount, eject; format removable drives only
- `files` - Files: tabs, drives, Recycle Bin, search, properties
- `game2048` - 2048
- `installer` - Install Selene OS (live session only): language, keyboard, disk, account, time zone
- `mail` - Mail: IMAP/SMTP accounts, compose, attachments
- `maps` - Maps: OpenStreetMap tiles, place search (Nominatim), saved places
- `media` - Player: music and video libraries, queue, playlists
- `minesweeper` - Minesweeper
- `nettools` - Network tools: VPN / WireGuard connections (NetworkManager), ping, DNS lookup
- `notepad` - Text Editor: plain text with tabs, find/replace, encodings
- `notes` - Notes: notebooks, rich text, checklists, pictures and tags, saved as you type
- `paint` - Draw: draw and edit pictures
- `passwords` - Passwords: encrypted vault (AES-GCM, PBKDF2), generator, CSV import/export
- `pdf` - PDF Reader: read, search, annotate and present PDFs
- `photos` - Photos: gallery, viewer, slideshow and editor
- `recorder` - Voice Recorder: MediaRecorder Opus/WebM, pause, markers, live waveform, microphone choice, seekable playback (WebAudio), trim re-encoded with WebCodecs (`lib/webm.js` writes the Duration and muxes Opus); Documents/Sound recordings
- `remote` - Remote Desktop: VNC client (RFB 3.8, None / VNC authentication); RDP later
- `settings` - Settings: system, devices, network, personalization, accounts, time and language, updates
- `snake` - Snake
- `snipping` - Screenshot: screen captures with markup
- `solitaire` - Solitaire (Klondike)
- `sticky` - Memos: small always-on-top notes, colours, basic formatting, copy to Notes
- `store` - Software: curated command-line tools and services installed with apt (through aurora-admin)
- `taskmgr` - System Monitor: processes, performance, users, details, services
- `terminal` - Terminal: real PTY, tabs, split panes, profiles
- `todo` - Tasks: lists, My Day, reminders, due dates, steps
- `translate` - Translator: MyMemory or LibreTranslate, English dictionary, offline EN↔FR glossary
- `weather` - Weather: Open-Meteo current conditions, 24 h and 7-day forecasts; sets the dynamic wallpaper location
- `winver` - About Selene: version and license information

## Rules for parallel work

- **Own your files.** Edit only the files and folders your task names. Shared core files
  (`core/ui.js`, `core/wm.js`, `core/registry.js`, `core/services.js`, `core/i18n.js`, `main/index.js`,
  `main/lib/*`) may get *additive*, backwards-compatible changes only, and only when your task
  really needs them.
- **Strings.** Apps use `apps/<id>/i18n.json`. Core features call
  `i18n.extend({ en: {…}, fr: {…} })` from their module instead of editing `core/i18n/*.json`.
- **CSS.** Apps use their own `style.css`. Features call `ui.loadCss('app://shell/core/features/<name>.css')`.
- **No new npm dependencies.** Available: `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`
  (served from `app://shell/node_modules/...`), `imapflow`, `nodemailer`, `mailparser` (main process only).
- **OS packages.** If a feature needs an apt package in the image, add it to
  `iso/packages.d/<feature>.list` (one package per line).
- **No git commits.** The coordinator commits.
- **Security.** Web content (browser tabs, e-mail bodies) is always sandboxed (`<webview>` with a
  `browser`/`mail` partition, or `<iframe sandbox>`). Never give it Node or the `aurora` bridge.
