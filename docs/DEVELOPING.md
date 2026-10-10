# Aurora OS developer guide

Aurora OS is Ubuntu 24.04 with a custom desktop. The desktop ("Aurora Shell") is one fullscreen
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
    renderer/assets/        icons (Fluent, MIT), wallpapers, logos
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
  `setIcon`, `close`, `minimize`, `maximize`, `focus`, `setFullscreen`, `setProgress`, `flash`,
  `onBeforeClose`, `on('resize'|'focus'|'blur'|'close'|…)`. All windows get the title bar, controls,
  resize handles, snapping and animations for free.
- **`ctx.ui`** (UI kit): `menu`, `dialog`, `alert`, `confirm`, `prompt`, `filePicker`, `toggle`, `slider`,
  `select`, `segmented`, `fileIcon`, `loadCss`. **`ctx.h`** builds DOM; **`ctx.icon(name)`** draws a Fluent
  icon. Check that a name exists with
  `node -e 'console.log(Object.keys(require("./renderer/assets/icons/fluent.json")).filter(k=>k.includes("arrow")).join(" "))'`.
- **`ctx.t(key, vars)`**: looks in `apps/<id>/i18n.json` (`{ "en": {…}, "fr": {…} }`), then in the core
  dictionary (`common.ok`, `common.cancel`, `common.save`, …). Plurals use the `key_one` / `key_other`
  forms with `{ count }`. **Every visible string must exist in English and French.**
- **`ctx.shell`** (shell services): `launch(appId, args)`, `openFile(path)`, `openUrl(url)`,
  `notify({title, body, icon, appId})`, `runAdmin(action, args, {reason, appId})` (shows a UAC prompt),
  `clipboard.setFiles/getFiles`, `xdg` (user folders), `lock()`, `logout()`.
- **`ctx.storage.get/set(name, value)`**: per-app JSON in `~/.config/aurora/apps/<id>/`.
- **`ctx.api.invoke(channel, …args)`**: the backend (list below). `ctx.api.mediaUrl(path)` turns a local
  file into a URL for `<img>`, `<video>` and `<audio>`, with seeking support.
- **`ctx.settings`**: `get('theme')`, `on('theme', fn)`.

### Visual rules (Windows 11 / Fluent)

- Use the CSS tokens from `core/tokens.css` (`--text`, `--text-2`, `--card`, `--stroke`, `--accent`,
  `--subtle-hover`, radii, `--ease`, durations) and the classes from `core/ui.css` (`.btn`, `.btn.primary`,
  `.btn.subtle`, `.input`, `.select`, `.toggle`, `.slider`, `.card`, `.card-row`, `.list-item`, `.nav-item`,
  `.toolbar`, `.tabs`, `.segmented`, `.infobar`, `.empty`, typography classes).
- Never hard-code colors that break dark mode. Test **light + dark** and **en + fr**.
- Font: 14px body, 12px captions, Segoe-like (Inter). Radius: 4px controls, 8px cards and windows.
- Animate with `transform`/`opacity` only, using `var(--ease)`; respect `[data-animations="off"]`.
- Scope your CSS under `.app-<id>` (the window gets that class) so apps never clash.

### Backend API (`api.invoke`)

| Area | Channels |
|---|---|
| files | `fs:home` `fs:xdg` `fs:list` `fs:stat` `fs:exists` `fs:readText` `fs:writeText` `fs:readBytes` `fs:writeBytes` `fs:mkdir` `fs:uniqueName` `fs:rename` `fs:copy` (+`fs:progress` events) `fs:trash` `fs:trashList` `fs:trashRestore` `fs:trashEmpty` `fs:delete` `fs:search` `fs:watch`/`fs:unwatch` (+`fs:changed`) `fs:drives` `fs:mount` `fs:unmount` `fs:eject` `fs:usage` `fs:dirSize` |
| system | `sys:info` `sys:stats` `power:shutdown` `power:reboot` `power:suspend` `session:logout` `apps:list` |
| shell | `shell:zoom` `shell:capture(rect)` `shell:screenSize` `clipboard:readText` `clipboard:writeText` `clipboard:writeImage` `clipboard:readImage` |
| settings | `settings:all` `settings:get` `settings:set` `settings:reset` (+`settings:changed`), `storage:get` `storage:set` `storage:delete` `storage:dir` |

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
