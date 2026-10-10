# Aurora OS — Personalization

This document is the contract for every personalization feature: the settings keys, what applies them,
how visual styles and per-app themes work, and the profile system. Each area appends its
keys here when it implements them.

- **Area A:** theme engine, visual styles, typography, shape, scale, per-app themes, profiles and the
  Theme designer.
- **Area B1:** wallpaper engine.
- **Area B2:** taskbar, Start and Focus mode.
- **Area B3:** packs and input.

Rules for every key:

- **Applies live.** No restart; the shell listens with `settings.on(key, fn)`.
- **Persists.** It is written with `settings:set` or `settings:setMany` to `~/.config/aurora/settings.json`.
  Only user overrides are stored.
- **Has a default** in `shell/main/ipc/settings.js` → `DEFAULTS`.
- **Is reachable** from the Settings app (Personalization) in English and French.
- **Is saved and restored by profiles:** listed in `PROFILE_KEYS` in `shell/renderer/core/profiles.js`.

## 1. Settings schema

### 1.1 Area A — theme engine (implemented by `core/theme.js`)

| Key | Type / range | Default | Effect |
|---|---|---|---|
| `style` | `'win11' \| 'minimal' \| 'glass' \| 'retro' \| 'contrast'` | `'win11'` | Visual style: `<html data-style>` plus the style layer `core/styles/<style>.css` |
| `theme` | `'light' \| 'dark'` | `'light'` | Colour mode: `<html data-theme>` |
| `autoTheme` | `{ enabled: bool, light: 'HH:MM', dark: 'HH:MM' }` | `{ enabled:false, light:'07:00', dark:'19:00' }` | **Auto** mode. theme.js writes `theme` at the two times, so every consumer keeps reading plain `'light'`/`'dark'` |
| `accent` | `'#rrggbb'` | `'#0078d4'` | Accent colour → `--accent*` (shades depend on the mode) |
| `accentFromWallpaper` | bool | `false` | When on, theme.js picks the most vivid colour of the wallpaper and writes it to `accent` |
| `transparency` | bool | `true` | `false` = every surface opaque, no backdrop blur, no Mica (`<html data-transparency="off">`) |
| `transparencyLevel` | 0–100 | `50` | 0 = opaque … 50 = Windows 11 look … 100 = most see-through. Sets `--tp`, the alpha factor of `--mica-tint*`, `--acrylic*`, `--fly-bg` and `--taskbar-bg` |
| `blur` | 0–100 | `50` | Blur intensity. Surfaces: `--blur` = 0–80 px (40 px at 50); `--blur-sm/-md/-lg` = ×0.5/×0.75/×1.5. The Mica copy of the wallpaper is pre-blurred 0–36 px |
| `cornerRadius` | 0–200 (%) | `100` | Multiplies the style's radii: `--radius-xs/-sm/(base)/-lg` = `--r-*` × `--corner` |
| `fontFamily` | `'inter' \| 'system' \| 'noto-sans' \| 'dejavu-sans' \| 'liberation-sans' \| 'noto-serif' \| 'dejavu-serif' \| 'cascadia' \| 'unifont'` | `'inter'` | `--font` / `--font-display`. Fonts that are not installed are greyed out in Settings |
| `textScale` | 80–150 (%) | `100` | Scales the `--fs-*` font-size tokens and the `--lh-*` line heights; the rest of the layout keeps its size |
| `scale` | 100–200 (%) | `100` | UI zoom (`shell:zoom`); pre-existing |
| `reducedMotion` | bool | `false` | Implies `data-animations="off"`. Also sets `<html data-reduced-motion="on">`: no animated wallpaper, no cross-fades, no parallax |
| `animations` | bool | `true` | Animation effects; pre-existing. `false` = `data-animations="off"` |
| `taskbar.color` | `null \| 'accent' \| '#rrggbb'` | `null` | `null` = theme default. Otherwise sets `--taskbar-custom`; `#taskbar` gets `data-theme` light/dark from the colour's luminance, so icons and text stay readable |
| `taskbar.opacity` | `null \| 0–100` | `null` | `null` = follows `transparencyLevel`; a number fixes the taskbar alpha (`--a-taskbar`) |
| `appThemes` | `{ [appId]: { theme: 'system'\|'light'\|'dark', accent: null\|'#rrggbb' } }` | `{}` | Per-app theme: see §3 |

Notes:

- **Visual styles have traits** (`STYLES` in theme.js):
  - `minimal`: monochrome accent, no Mica.
  - `glass`: stronger transparency, colourful Mica.
  - `retro`: no blur.
  - `contrast`: forced opaque, no blur, own palette.
- **Traits beat the sliders**, e.g. *transparency* has no effect in High contrast. Settings shows a note when a
  control is overridden by the style.

### 1.2 Reserved keys (defaults exist; implemented by later areas)

The pages that will host them are already registered in Settings as stubs.

**B1 — wallpaper engine** (page `wallpaperEffects`, module `pages/personalization-wallpaper.js`)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `wallpaperMode` | `'static' \| 'animated' \| 'dynamic'` | `'static'` | Which engine draws the desktop background |
| `animatedWallpaper` | `{ id: string, speed: 0–100 }` | `{ id:'aurora', speed:50 }` | Animated scene. At most 30 fps; paused when hidden or covered and when `reducedMotion` is on |
| `dynamicWallpaper` | `{ source: 'time'\|'weather', set: string, location: null\|{ name, lat, lon } }` | `{ source:'time', set:'bloom', location:null }` | Picture set that follows the time of day or the weather (Open-Meteo) |
| `wallpaper`, `wallpaperFit`, `lockWallpaper` | pre-existing | | Static picture and the separate lock screen picture |

**B2 — taskbar, Start, Focus mode** (pages `taskbar`, `start` in `pages/personalization-taskbar.js`;
`focus` in `pages/personalization-focus.js`)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `taskbar.size` | `'small' \| 'medium' \| 'large'` | `'medium'` | Taskbar height and icon size |
| `taskbar.position` | `'bottom' \| 'top' \| 'left' \| 'right'` | `'bottom'` | Screen edge |
| `taskbar.showLabels` | bool | `false` | Show app names next to icons |
| `taskbar.combine` | `'always' \| 'whenFull' \| 'never'` | `'always'` | Combine buttons of the same app |
| `taskbar.widgets` | `string[]` | `[]` | Mini widgets in the tray (e.g. `'weather'`, `'cpu'`) |
| `taskbar.align`, `taskbar.autohide`, `taskbar.showSearch`, `taskbar.showTaskView`, `taskbar.showWidgets` | pre-existing | | |
| `start.layout` | `'default' \| 'morePins' \| 'moreRecommended' \| 'list'` | `'default'` | Start layout |
| `start.background` | `'acrylic' \| 'solid' \| 'accent' \| 'wallpaper'` | `'acrylic'` | Start background style |
| `start.folders` | `string[]` | `[]` | Folders next to the power button (`documents`, `downloads`, `music`, `pictures`, `videos`, `files`, `settings`) |
| `start.groups` | `{ id, name, apps: string[] }[]` | `[]` | App folders inside Pinned |
| `startShowRecent`, `startPinned`, `pinned` | pre-existing | | Pinned lists are *content* and are **not** part of profiles |
| `focusMode` | `{ active, hideNotifications, dimDesktop, dimLevel (0–100), simplifyTaskbar, duration (min, 0 = until off) }` | `{ active:false, hideNotifications:true, dimDesktop:true, dimLevel:40, simplifyTaskbar:true, duration:0 }` | Focus mode. `active` is runtime state and is excluded from profiles |

**B3 — packs and input** (pages `cursors`, `iconPacks`, `soundPacks` in `pages/personalization-packs.js`;
`shortcuts`, `snapPresets` in `pages/personalization-input.js`)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `cursorPack` | string | `'default'` | Cursor theme |
| `iconPack` | string | `'fluent'` | App / file icon pack |
| `soundPack` | string | `'aurora'` | System sound scheme |
| `soundEvents` | `{ notification, startup, shutdown }`, each `null \| 'none' \| soundId \| path` | all `null` | Per-event overrides. `null` = the pack's sound. **Not `sounds.*`:** `sounds` is the existing on/off boolean |
| `snapPresets` | `{ id, name, zones: [{x,y,w,h}] (fractions 0–1) }[]` | `[]` | Custom snap layouts shown next to the built-in ones |
| `shortcuts` | `{ [actionId]: combo \| null }` | `{}` | Overrides of the shell shortcuts (combo syntax of `main/lib/hotkeys.js`, `null` = disabled) |

## 2. Theme engine (`core/theme.js`, `core/tokens.css`)

### Tokens on any element

Every colour token is declared for `:root[data-theme=X]` **and** `[data-theme=X]`, so any element that
carries `data-theme="light|dark"` gets the full token set. Elements that do this:

- an app window (per-app theme);
- `#taskbar` (custom taskbar colour);
- previews in Settings.

Accent variables are set inline (`--accent`, `--accent-hover`, `--accent-pressed`, `--accent-text`,
`--accent-subtle`, `--on-accent`, `--accent-base`). Use `accentVars(hex, mode)` to compute them for an
element.

### Computed variables

theme.js writes them into `<style id="aurora-theme-vars">` with `:root` specificity, so a style layer can
still override them:

| Variable | Source |
|---|---|
| `--tp` | Alpha factor (0 = opaque) from `transparency` and `transparencyLevel` |
| `--blur`, `--blur-sm`, `--blur-md`, `--blur-lg` | `blur` |
| `--corner` | `cornerRadius` / 100 |
| `--font`, `--font-display` | `fontFamily` |
| `--text-scale` | `textScale` / 100 |
| `--a-taskbar` (when `taskbar.opacity` is set) | `taskbar.opacity` |
| `--taskbar-custom` (when `taskbar.color` is set) | `taskbar.color` |

### Attributes on `<html>`

`data-theme`, `data-style`, `data-transparency`, `data-animations`, `data-reduced-motion`.

### Helpers (`import { … } from 'app://shell/core/theme.js'`)

- `theme.on('change' | 'wallpaper' | 'mica' | 'style', fn)`.
- `theme.mode`, `theme.style`.
- `effectiveTheme(el)`: the light/dark mode in effect for an element (honours per-app themes). Apps
  that draw on a canvas should use this instead of reading `document.documentElement.dataset.theme`.
- `theme.transition(async fn)`: runs `fn` inside a ~300 ms cross-fade of the whole UI (skipped when
  animations are off).
- `STYLES`, `FONTS`, `fontInstalled(id)`.

### Performance

- The Mica copy of the wallpaper is computed once per wallpaper, blur or style change, on a 320 px
  canvas.
- Real `backdrop-filter` is used only on small surfaces (taskbar, flyouts, menus, toasts). Windows
  never use a live backdrop blur, even in the Glass style: their translucency shows the pre-blurred
  wallpaper (Mica).

## 3. Per-app themes

`settings.appThemes[appId] = { theme: 'system' | 'light' | 'dark', accent: null | '#rrggbb' }`.

theme.js watches `#windows` (MutationObserver) and decorates every `.win[data-app]`:

- **Theme different from the system mode:** the window gets `data-theme`.
- **Custom accent, or forced mode:** the window gets inline accent variables.
- **App stylesheets:** written with `:root[data-theme="dark"] .app-x …`. When the app is loaded,
  `registry.js` asks theme.js to rewrite those rules so they follow the window's own mode.
- **Menus and tooltips:** opened from that window (appended to `<body>`), they copy its theme.
- **Dialogs:** a dialog with `parent: win` lives inside the window and inherits its theme.

## 4. Visual styles (`core/styles/<style>.css`)

All style sheets are loaded at boot by theme.js, along with `base.css`, which holds the shared effects:

- blur intensity on the feature surfaces;
- line heights scaled by `--text-scale`.

Each style is written inside `@scope ([data-style="<id>"])`, so it applies to `<html>` and to any element
carrying `data-style`. The style cards in Settings use this to render real mini-previews. The closest
`data-style` wins (scope proximity).

| Style | Look |
|---|---|
| `win11` | The default Fluent / Windows 11 look; no overrides |
| `minimal` | Flat, opaque, no blur, thin 1 px strokes, soft shadows, more whitespace, monochrome accent |
| `glass` | Glassmorphism: very translucent frosted panels (windows included), bright borders and highlights, larger radii, colourful backdrop glow |
| `retro` | Original 90s/2000s desktop: bevelled 3D buttons, gradient title bars, square corners, teal and grey palette, crisp text |
| `contrast` | High contrast. Dark: black, white text, yellow and cyan focus and links. Light: white, black text, dark blue and purple. Opaque, thick borders, text contrast ≥ 7:1 (WCAG AAA) |

The lock screen (shell) and the sign-in screen (`greeter.js`) also get `data-style`.

## 5. Profiles (`core/profiles.js`)

**What a profile is:** a profile is `{ id, name, builtin?, created, updated, values }`. `values` maps every
key in `PROFILE_KEYS` to its value:

- the Area A keys;
- `wallpaper`, `wallpaperFit`, `lockWallpaper` and the B1 keys;
- the taskbar and Start layout keys;
- `focusMode` (without `active`);
- packs, `soundEvents`, `snapPresets`, `shortcuts`, `desktopIconSize`, `appThemes`.

`PROFILE_EXCLUDE` lists sub-keys that are never saved (`focusMode.active`). **Later areas append their new keys to
`PROFILE_KEYS`.**

**Storage:** user profiles are stored with `storage:get/set('shell', 'profiles')` as
`{ version: 1, profiles: [...] }`.

**Applying:** one `settings:setMany` call. A key missing from a user profile is reset to its default. The
call runs inside `theme.transition()`, a ~300 ms cross-fade.

**Built-in profiles** only set the *look* keys (`LOOK_KEYS`). They never touch accessibility (`textScale`,
`scale`, `reducedMotion`, `animations`) or layout keys. The built-ins are:

- Aurora Light
- Aurora Dark
- Glass
- Minimal
- Retro
- High Contrast
- Night Owl

**Export and import:**

- **Export** writes `{ format: 'aurora-profile', version: 1, name, values }`.
- **Import** validates it:
  - file ≤ 256 KB, right format and version;
  - unknown keys are dropped;
  - every value is checked against the key's type and range;
  - wallpaper paths go through `resolveWallpaper`'s scheme allow-list.

API:

```js
import { profiles, PROFILE_KEYS } from 'app://shell/core/profiles.js';
await profiles.list();                 // built-ins + user profiles
await profiles.saveCurrent('My theme');
await profiles.apply(id);              // one click, cross-fade
await profiles.rename(id, name); await profiles.duplicate(id); await profiles.remove(id);
const json = await profiles.exportJson(id); await profiles.importJson(text);
profiles.current();                    // id of the profile matching the current settings, or null
// From anywhere in the shell (quick settings, a hotkey, another app):
shell.emit('profiles:apply', { id });  // also window.__aurora.theme.profiles
```

## 6. Settings pages

**Personalization** contains:

- the hero preview;
- **Theme designer** (`themeDesigner`);
- **Visual style** (`visualStyle`);
- **Profiles** (`profiles`);
- **App themes** (`appThemes`);
- Background;
- Colors;
- Themes;
- Lock screen;
- **Taskbar** and **Start** (module `personalization-taskbar.js`, owned by B2);
- the stubs: `wallpaperEffects`, `focus`, `cursors`, `iconPacks`, `soundPacks`, `shortcuts`, `snapPresets`.

**Accessibility** reuses the same control builders (`textSizeControls`, `motionControls` exported by
`pages/personalization-designer.js`), so each setting has a single source of truth:

- **Text size** has the text size and the UI scale.
- **Visual effects** has transparency, animations and reduced motion.

## 7. Backend: `settings:setMany`

```js
api.invoke('settings:setMany', { 'style': 'retro', 'taskbar.color': null, … }, { reset: ['blur'] })
```

- **Atomic:** every key is applied to the user overrides at once, then the file is saved once.
- **One broadcast:** a single `settings:changed` with `{ key: '*', keys: [...], all }`. Renderer listeners
  run once.
- **Return value:** the merged settings.
