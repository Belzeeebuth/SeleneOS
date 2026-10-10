# Aurora OS — Personalization

This document is the contract for every personalization feature: the settings keys, what applies them,
how visual styles and per-app themes work, and the profile system. Each area appends its
keys here when it implements them.

- **Area A:** theme engine, visual styles, typography, shape, scale, per-app themes, profiles and the
  Theme designer.
- **Area B1:** wallpaper engine — animated, dynamic (time of day, weather), slideshow, lock screen (§9).
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
| `autoTheme` | `{ enabled: bool, light: 'HH:MM', dark: 'HH:MM' }` | `{ enabled:false, light:'07:00', dark:'19:00' }` | **Auto** mode. theme.js writes `theme` at the two times, so every consumer keeps reading plain `'light'`/`'dark'`. It also applies the schedule when Auto is turned on (or its times change) and at boot. In between, a manual light/dark choice (quick settings, a profile) is kept until the next boundary |
| `accent` | `'#rrggbb'` | `'#0078d4'` | Accent colour → `--accent*` (shades depend on the mode) |
| `accentFromWallpaper` | bool | `false` | When on, theme.js picks the most vivid colour of the wallpaper and writes it to `accent` |
| `transparency` | bool | `true` | `false` = every surface opaque, no backdrop blur, no Mica (`<html data-transparency="off">`) |
| `transparencyLevel` | 0–100 | `50` | 0 = opaque … 50 = Windows 11 look … 100 = most see-through. Sets `--tp`, the alpha factor of `--mica-tint*`, `--acrylic*`, `--fly-bg` and `--taskbar-bg` |
| `blur` | 0–100 | `50` | Blur intensity. Surfaces: `--blur` = 0–80 px (40 px at 50); `--blur-sm/-md/-lg` = ×0.5/×0.75/×1.5. The Mica copy of the wallpaper is pre-blurred 0–36 px |
| `cornerRadius` | 0–200 (%) | `100` | Multiplies the style's radii: `--radius-xs/-sm/(base)/-lg` = `--r-*` × `--corner` |
| `fontFamily` | `'inter' \| 'system' \| 'noto-sans' \| 'dejavu-sans' \| 'liberation-sans' \| 'noto-serif' \| 'dejavu-serif' \| 'cascadia' \| 'unifont'` | `'inter'` | `--font` / `--font-display`. Fonts that are not installed are greyed out in Settings |
| `textScale` | 80–150 (%) | `100` | Scales the `--fs-*` font-size tokens and the `--lh-*` line heights; the rest of the layout keeps its size. The first time it differs from 100, theme.js also rewrites every plain `font-size: Npx` / `line-height: Npx` of the shell and app stylesheets to `calc(Npx * var(--text-scale, 1))`, so hard-coded sizes follow too |
| `scale` | 100–200 (%) | `100` | UI zoom (`shell:zoom`); pre-existing |
| `reducedMotion` | bool | `false` | Implies `data-animations="off"`. Also sets `<html data-reduced-motion="on">`: no animated wallpaper, no cross-fades, no parallax |
| `animations` | bool | `true` | Animation effects; pre-existing. `false` = `data-animations="off"` |
| `taskbar.color` | `null \| 'accent' \| '#rrggbb'` | `null` | `null` = theme default. Otherwise `#taskbar` gets `--taskbar-rgb` plus `data-theme-scope` and `data-theme` light/dark (from the colour's luminance), so icons and text stay readable. `'accent'` uses a deep shade of the accent |
| `taskbar.opacity` | `null \| 0–100` | `null` | `null` = follows `transparencyLevel`; a number fixes the taskbar alpha (`--a-taskbar`) |
| `appThemes` | `{ [appId]: { theme: 'system'\|'light'\|'dark', accent: null\|'#rrggbb' } }` | `{}` | Per-app theme: see §3 |

Notes:

- **Visual styles have traits** (`STYLES` in theme.js):
  - `minimal`: opaque, no blur, graphite accent.
  - `glass`: transparency ×2.3, Mica pre-blur ×0.8 and saturation ×1.9.
  - `retro`: opaque, no blur.
  - `contrast`: opaque, no blur, its own palette, ignores `taskbar.color`.
- **Traits beat the sliders**, e.g. *transparency* has no effect in High contrast. Settings shows a note when a
  control is overridden by the style.

### 1.2 Reserved keys (defaults exist; implemented by later areas)

The pages that will host them are already registered in Settings as stubs.

**B1 — wallpaper engine**: implemented, see §9 (`wallpaperMode`, `animatedWallpaper`, `dynamicWallpaper`, `slideshow`,
`lockScreen`).

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

Every colour token is declared for `:root[data-theme=X]` **and** `[data-theme-scope][data-theme=X]`, so any element
that carries `data-theme-scope data-theme="light|dark"` gets the full token set. The extra marker attribute keeps the
existing uses of `data-theme` (chess board themes, Settings theme tiles) unaffected. Elements that do this:

- an app window (per-app theme);
- `#taskbar` (custom taskbar colour);
- menus opened from a themed window;
- previews in Settings.

Accent variables are set inline (`--accent`, `--accent-hover`, `--accent-pressed`, `--accent-text`,
`--accent-subtle`, `--on-accent`, `--accent-base`). Use `accentVars(hex, mode)`, or `styleAccentVars(style, hex, mode)`, which honours the
Minimal and High contrast palettes, to compute them for an element.

### Computed variables

theme.js writes them into `<style id="aurora-theme-vars">` with `:root` specificity, so a style layer can
still override them:

| Variable | Source |
|---|---|
| `--tp` | Alpha factor (0 = opaque) from `transparency` and `transparencyLevel`; a style multiplies it by its `--tp-k` |
| `--blur-px` (→ `--blur`, `--blur-sm`, `--blur-md`, `--blur-lg`, × the style's `--blur-k`) | `blur` |
| `--corner` | `cornerRadius` / 100 |
| `--font`, `--font-display` | `fontFamily` |
| `--text-scale` | `textScale` / 100 |
| `--a-taskbar` (when `taskbar.opacity` is set) | `taskbar.opacity` |
| `--taskbar-rgb` (inline on `#taskbar`, when `taskbar.color` is set) | `taskbar.color` |

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
- `setWallpaperOverride(url | null)` (area B1): the picture the wallpaper engine shows instead of `settings.wallpaper`
  (desktop, Mica, accent from wallpaper and the lock screen follow it); `theme.wallpaperOverride` reads it back. See §9.2.

### Performance

- The Mica copy of the wallpaper is computed once per wallpaper, blur or style change, on a 320 px
  canvas. The wallpaper is decoded once and cached as a ≤ 640 px canvas. A blur or style change on the same
  picture re-blurs it 160 ms after the last change, so dragging the blur slider costs one re-blur, not one per step.
- Real `backdrop-filter` is used only on small surfaces (taskbar, flyouts, menus, toasts). Windows
  never use a live backdrop blur, even in the Glass style: their translucency shows the pre-blurred
  wallpaper (Mica).

## 3. Per-app themes

`settings.appThemes[appId] = { theme: 'system' | 'light' | 'dark', accent: null | '#rrggbb' }`.

theme.js watches `#windows` (MutationObserver) and decorates every `.win[data-app]`:

- **Theme different from the system mode:** the window gets `data-theme`.
- **Custom accent, or forced mode:** the window gets inline accent variables.
- **App stylesheets:** written with `:root[data-theme="dark"] .app-x …`. theme.js watches `<head>`, and when an app's
  stylesheet loads (`app://shell/apps/…`) it rewrites those selectors in the CSSOM:
  - `:root[data-theme="dark"] X` becomes "root is dark and X is not inside a themed window" plus "X is in, or is, a
    dark-themed window" (`scopeThemeSelector()`).
  - Specificity is unchanged (`:where`), so apps need no change.
  - JS that reads `document.documentElement.dataset.theme` should switch to `effectiveTheme(el)`.
- **Menus and tooltips:** a menu opened from that window (appended to `<body>`) copies its theme. A tooltip copies
  the theme of the window under the pointer.
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

The lock screen (shell) and the sign-in screen (`greeter.js`) also get `data-style`. High contrast puts a 74 %
black veil over the lock-screen picture so that its white text and links stay ≥ 7:1 on any wallpaper.

**Title bars.** Retro and High contrast recolour the title bar (`--text` becomes the title colour). Anything an app
puts in `win.titlebarSlot` that paints the window's own surface or a field gets the body colours back:
the selected tab (`[role="tab"]` with `.active`, `.selected` or `aria-selected="true"`) and fields (`input`, `textarea`,
`select`, `.input`, `.search-box`). Notepad, Terminal, Browser, Files and Task Manager already follow this. Toggle
buttons that sit on the title bar itself (Snipping Tool) keep the title colours.

**Text size and fixed chrome.** The two-line taskbar clock grows with the text size up to 14.5 px / 18 px line
height, so it always fits the 48 px taskbar (`styles/base.css`).

**Reduced motion / animations off** also stops infinite animations after one 1 ms iteration (no flickering
spinners).

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
  - every value is checked against the key's type and range. Every key in `PROFILE_KEYS` has a validator in
    `VALIDATORS`:
    - identifiers (pack, widget, app, folder ids) must be slugs (`[a-z0-9._-]`);
    - names are bounded and stripped of control characters and `<>`;
    - snap zones must lie inside the screen;
    - shortcuts must be combos without quotes or brackets;
    - sound files must be absolute paths to audio files;
  - no prototype keys (`__proto__`, `constructor`, `prototype`) at any level;
  - pictures: `builtin:`, absolute local paths (no `..`) or inline `data:image/…`. An SVG may not reference other
    resources. Remote `http(s)` pictures are refused, so an imported profile can never make the desktop contact a
    server.
  - The generic fallback for a future key without a validator keeps only inert JSON: no quotes, brackets,
    parentheses, backslashes or control characters in strings.

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

**Strings** (`pz.*`, English and French) live in `apps/settings/i18n.json`. Shared page helpers live in
`pages/personalization-strings.js` (`comingSoon()` for stub pages). Page styles are in
`pages/personalization.css`, which the modules load with `ui.loadCss`.

**Personalization** contains:

- the hero preview;
- **Theme designer** (`themeDesigner`);
- **Visual style** (`visualStyle`);
- **Profiles** (`profiles`);
- **App themes** (`appThemes`);
- Background (module `personalization-wallpaper.js`, area B1, §9.6);
- Colors;
- Themes;
- Lock screen (module `personalization-wallpaper.js`, area B1);
- **Animated & dynamic wallpapers** (`wallpaperEffects`, area B1);
- **Taskbar** and **Start** (module `personalization-taskbar.js`, owned by B2);
- the stubs: `focus`, `cursors`, `iconPacks`, `soundPacks`, `shortcuts`, `snapPresets`.

**Accessibility** reuses the same control builders (`textSizeControls`, `motionControls` exported by
`pages/personalization-designer.js`), so each setting has a single source of truth:

- **Text size** has the text size and the UI scale.
- **Visual effects** has transparency, animations and reduced motion.

### Replacing a stub (areas B1–B3)

1. Replace the module (`pages/personalization-wallpaper.js`, `personalization-taskbar.js`, `personalization-focus.js`,
   `personalization-packs.js` or `personalization-input.js`). Keep the page ids listed in `lib/index.js` → `PAGES`,
   which also feed the search index and `manifest.json` → `searchIndex`. **Regenerate** `manifest.json` → `searchIndex`
   whenever you add `ENTRIES`; test/system-settings.test.mjs checks the two match.
2. Reuse the control builders: `ctl()`, `liveSlider()` and `bindToggle()` exported by `personalization-designer.js`.
3. Implement the runtime in the shell. Read the keys with `settings.get` / `settings.on` and keep the defaults in
   `main/ipc/settings.js`.
4. Append new keys to `PROFILE_KEYS`, and to `LOOK_KEYS` if the built-in profiles should reset them. Add a validator to
   `VALIDATORS`; there is a generic type check otherwise.
5. Check `data-reduced-motion="on"` on `<html>` for anything animated.

## 7. Backend: `settings:setMany`

```js
api.invoke('settings:setMany', { 'style': 'retro', 'taskbar.color': null, … }, { reset: ['blur'] })
```

- **Atomic:** every key is applied to the user overrides at once, then the file is saved once.
- **One broadcast:** a single `settings:changed` with `{ key: '*', keys: [...], all }`. Renderer listeners
  run once.
- **Return value:** the merged settings.
- **Key safety:** `settings:set`, `settings:setMany` and `settings:reset` refuse empty segments and prototype names
  (`__proto__`, `constructor`, `prototype`) with `EINVAL`. Merging the settings files skips such keys too, so a
  hand-edited `settings.json` cannot pollute the main process.

## 8. Known limitations

- **Windows never see each other through Glass.** Windows show the pre-blurred wallpaper (Mica), not the windows
  behind them. This keeps the cost at zero while dragging in a VM without a GPU.
- **Per-app themes and app JS.** Apps that read `document.documentElement.dataset.theme` in JS to choose canvas
  colours (Task Manager charts, the Mail reader, Notepad's "system" theme) keep following the system mode until they
  switch to `effectiveTheme(win.el)`. Their CSS already follows the window.
- **App-specific colours.** The visual styles restyle every shared token and class. An app's own hard-coded
  colours (`--fx-*`, `--ck-*`…) are unchanged; in High contrast these may stay below 7:1 inside some apps.
- **The sign-in screen** (greeter) runs before login, so it applies the style of the settings it can read: the system
  defaults (`/etc/aurora/settings.json`), not the user's.

## 9. Wallpaper engine (area B1)

Animated wallpapers, dynamic wallpapers (time of day and weather), the slideshow and the lock screen background.

### 9.1 Keys

| Key | Type / range | Default | Effect |
|---|---|---|---|
| `wallpaperMode` | `'static' \| 'animated' \| 'dynamic' \| 'slideshow'` | `'static'` | `static` = the picture or solid colour of `wallpaper` (drawn by `core/desktop.js`); the other modes are drawn by `core/features/wallpaper.js` |
| `animatedWallpaper` | `{ id, speed 0–100, intensity 0–100, fps 15\|30, pauseOnMaximized }` | `{ id:'aurora', speed:50, intensity:50, fps:30, pauseOnMaximized:true }` | `id`: `aurora`, `bloom`, `fluid`, `bokeh`, `starfield`, `waves`. Speed 50 = ×1 (0 = ×0.2, 100 = ×2.5). Intensity = brightness / amount of detail of the effect |
| `dynamicWallpaper` | `{ source: 'time'\|'weather', set: 'bloom'\|'dunes'\|'lake', location: null\|{ name, lat, lon }, followTheme }` | `{ source:'time', set:'bloom', location:null, followTheme:false }` | Time-of-day set; `weather` adds the current weather; `location: null` = fixed day 07:00–19:00; `followTheme` writes `theme` (light from sunrise to sunset) unless `autoTheme.enabled` |
| `slideshow` | `{ folder: null\|'/abs/path', interval 1–1440 (min), shuffle }` | `{ folder:null, interval:30, shuffle:true }` | `folder: null` = the built-in pictures (every static and time-of-day picture) |
| `lockScreen` | `{ mode: 'picture'\|'spotlight'\|'animated', effect }` | `{ mode:'picture', effect:'aurora' }` | `picture` = `lockWallpaper` (null = same as the desktop, including the animated / dynamic / slideshow picture); `spotlight` = a different built-in picture every day; `animated` = the `effect` scene, lightweight |
| `wallpaper`, `wallpaperFit`, `lockWallpaper` | pre-existing | | Static picture, its fit, and the lock screen picture |

All of them are in `PROFILE_KEYS` (validators in `core/profiles.js`); `wallpaperMode` is also a `LOOK_KEYS` key, so the
built-in profiles go back to a static picture.

### 9.2 How it is drawn

- **Layers.** `features/wallpaper.js` inserts `#desktop > .wp-engine` right after `#desktop > .wallpaper` (the desktop
  picture of `core/desktop.js`) and before the icons. Inside: `.wp-scene-host` (animated scene), `.wp-fades` (slow
  cross-fades), `.wp-tint` (weather colour wash, CSS), `.wp-overlay` (weather particles).
- **The picture under it.** Every mode hands a picture to `theme.setWallpaperOverride(url)` (`core/theme.js`, additive
  hook): the still frame of the animated scene (blob: JPEG of the hero frame), the time-of-day variant, or the slideshow
  picture. The desktop picture, the Mica material of windows, "accent from wallpaper" and the lock screen ("same as the
  desktop") all follow it. `null` restores `settings.wallpaper`. To avoid a feedback loop, effects drawn in the accent
  colour use the default blue while `accentFromWallpaper` is on.
- **Renderer** (`core/wallpaper/engine.js`, `WallpaperRenderer`): the animated canvas is drawn at a fraction of the screen
  resolution (`effect.scale`: ½, ¼ for the fluid gradient) and upscaled by CSS; layered effects (Aurora, Night sky) draw
  their static parts once at full resolution on their own canvases (`background` under, `foreground` over the animated
  canvas). Frame rate capped at 15 or 30 fps (requestAnimationFrame, frames skipped until the interval has passed); no
  allocation in the frame loop (typed arrays, pre-rendered sprites, pre-built gradients). `snapshot({ t })` composites a
  still frame.
- **Pausing** (`renderer.setPaused(reason)`): `covered` (a maximized or full-screen window on the current virtual desktop,
  when `pauseOnMaximized`), `locked` (lock screen), `hidden` (document hidden), `motion` (`reducedMotion` or animation
  effects off: a still frame, no loop). Nothing is scheduled while paused.
- **Effects** (`core/wallpaper/effects/*.js`, contract in `engine.js`): `aurora` (northern-lights curtains over a mountain
  lake, with reflection), `bloom` (the Aurora flower: petals sway and breathe, a light band glides over the glass; in the
  accent colour), `fluid` (mesh gradient in the accent colour), `bokeh` (drifting soft lights with parallax), `starfield`
  (Milky Way, twinkling stars, shooting stars), `waves` (layered swells in the accent colour). Light and dark variants.
- **Measured cost** (1600×900, software rendering, busy 4-core container): 1–3 ms per frame (fluid, bokeh, night sky,
  waves), 7–9 ms (bloom, aurora) — 30 fps aurora ≈ 25 % of one core; 15 fps halves it; 0 when paused.

### 9.3 Dynamic wallpaper

- **Sets** (`core/wallpaper/dynamic.js` `DYNAMIC_SETS`): Bloom, Dunes and Lakeside, each with dawn / day / dusk / night
  pictures in `renderer/assets/wallpapers/dynamic/` (original art, `xvfb-run -a node tools/gen-wallpapers.mjs --only=dynamic`;
  the Lakeside night is `aurora.jpg`).
- **Sun maths** (`core/wallpaper/solar.js`, no network): NOAA solar calculator — `sunTimes(date, lat, lon)` (sunrise /
  sunset at −0.833°, civil dawn / dusk, solar noon, polar day / night), `phaseAt(date, location)`:
  dawn = sunrise −40 min … +80 min, day, dusk = sunset −80 min … +40 min, night (shortened on short days). Without a
  location: fixed sunrise 07:00 / sunset 19:00. Paris, 21 June 2026: sunrise 05:46:56, sunset 21:57:53 (CEST).
- **Switching**: a timer at the next phase change (re-checked every minute: suspend, clock changes) cross-fades to the
  next variant over 4 s (none with reduced motion).
- **Theme follows the sun** (`followTheme`): light between sunrise and sunset, dark otherwise; turning it on in Settings
  turns the fixed-hours "Auto" mode of Colors off (and Auto wins if both are on).
- **Weather** (`source: 'weather'` + a location): conditions every 15 min (the backend caches 30 min); the kind decides
  a CSS colour wash (`weatherTint`) and, when animations are allowed, animated particles over the picture
  (`effects/weather.js`): clear (nothing), clouds (drifting cloud banks), rain, snow, fog (drifting haze), storm (heavy rain,
  gentle lightning far below the 3-flashes-per-second limit). With reduced motion only the static tint is shown.
  Offline: the last known conditions (marked stale) or the time of day alone.

### 9.4 Weather backend (`main/ipc/weather.js`) — reusable by the widgets board and a future Weather app

```js
await api.invoke('weather:current', { lat, lon, name }, { force })  // or no place: dynamicWallpaper.location
// → { location: { name, lat, lon }, code, kind: 'clear'|'clouds'|'fog'|'rain'|'snow'|'storm',
//     intensity: 'light'|'moderate'|'heavy', describe, isDay, temperature, unit: '°C', observed, fetchedAt, stale, source }
await api.invoke('weather:search', 'Paris', { lang: 'fr', count: 8 })
// → [{ id, name, admin1, country, countryCode, lat, lon, timezone }]
api.on('weather:changed', (conditions) => …)   // every fresh fetch (not cache hits)
await api.invoke('weather:stats')               // { requests, cacheHits, failures, lastUrl, urls, mock }
```

- Open-Meteo (no API key) through Electron `net.fetch`:
  `https://api.open-meteo.com/v1/forecast?latitude=…&longitude=…&current=weather_code,is_day,temperature_2m&timezone=auto`
  and `https://geocoding-api.open-meteo.com/v1/search?name=…&count=…&language=en|fr&format=json`.
- Cache: 30 min per place (memory + `~/.cache/aurora/weather.json`), searches 1 h; timeout 8 s; offline → last known
  conditions up to 24 h old with `stale: true`, else `EOFFLINE` / `ETIMEDOUT` / `ENOLOCATION`.
- `describe` is an i18n key: the Settings app translates it as `wp.w_<describe>` (clear, mainlyClear, partlyCloudy,
  overcast, fog, drizzle, freezingDrizzle, rain, freezingRain, snow, snowGrains, showers, snowShowers, thunderstorm, hail).
- WMO code mapping (`weatherKind(code)`, exported for tests): 0–1 clear, 2 clouds (light), 3 clouds (heavy), 45/48 fog,
  51–57 and 61–67 and 80–82 rain, 71–77 and 85–86 snow, 95 storm, 96/99 storm with hail.
- Offline city list for the location picker: `core/wallpaper/cities.js` (`searchCities(query, lang)`), merged with the
  online results.
- **Testing without network**: `AURORA_WEATHER_MOCK=/path/mock.json` replaces the HTTP requests; the file is re-read on
  every request: `{ "offline": false, "delayMs": 0, "current": { "weather_code": 61, "is_day": 1, "temperature_2m": 12 },
  "geocoding": [ … ] }`. `AURORA_WEATHER_TIMEOUT` (ms) shortens the timeout.

### 9.5 Slideshow and lock screen

- **Slideshow**: the pictures of `slideshow.folder` (jpg, png, webp, avif, gif, bmp; sorted, or shuffled once a day), a new
  one every `interval` minutes with the 4 s cross-fade; `shell.emit('wallpaper:next')` skips to the next one (Settings
  "Next picture"). An empty or missing folder falls back to the built-in pictures.
- **Lock screen** (`core/wallpaper/lock.js`): `core/features/lock.js` asks `ctx.wallpaperEngine.lockWallpaperUrl()` for the
  picture and calls `ctx.wallpaperEngine.attachLock(ls)` (both additive). Animated mode (or "same as the desktop" while
  the desktop is animated) runs the scene inside the lock screen's picture; it stops on the sign-in view, when the screen
  is dismissed, and with reduced motion. The blurred sign-in view uses a still frame of the scene.
- **Sign-in screen** (`core/greeter/greeter.js`, additive): the same three modes, from the settings it can read (the system
  defaults, `/etc/aurora/settings.json`).

### 9.6 Settings pages (`apps/settings/pages/personalization-wallpaper.js` + `.css`, strings `wp.*`)

- **Background** (`background`): live desktop preview and status ("On your desktop now"), and *Personalize your
  background*: Picture / Solid color / Slideshow / Animated / Dynamic (time of day), each with its own controls.
- **Animated & dynamic wallpapers** (`wallpaperEffects`): effect gallery with live mini previews (15 fps, only while
  visible), speed, intensity, frame rate, pause when apps are maximized; picture sets with their four phases; changes with
  time / time and weather; location (offline cities + online search + coordinates); today's sun times and next phase;
  light and dark follow the sun; current weather with Refresh; "Preview a weather" (only in the preview).
- **Lock screen** (`lockscreen`): Picture (grid with "Same as desktop") / Picture of the day (today + coming days) /
  Animated (effect gallery), and the screen timeout.
- Builders exported for other pages: `kindControl`, `effectGallery`, `animatedControls`, `setGallery`,
  `dynamicControls`, `slideshowControls`, `heroPreview`, `pickLocation`.

### 9.7 Shell API

`window.__aurora.wallpaperEngine` (also `shell.wallpaperEngine` for apps): `state` → `{ mode, effect, running, paused,
frames, fps, drawMs, overrideUrl, dynamic, weather, weatherError, weatherFx, slideshow }`, `renderer`, `weatherRenderer`,
`lockWallpaperUrl()`, `attachLock(ls)`, `next()`, `refresh()`, `setClock(date | null)` (tests: pretend another time).
Shell events: `wallpaper:changed` `{ mode, url }`, `wallpaper:weather` `{ weather, error }`, `wallpaper:next`.

### 9.8 Known limitations

- Animated scenes are 2D canvas only (no WebGL): this is the fast path with software rendering; with a GPU they would
  allow higher resolutions.
- The sign-in screen cannot read the user's settings: its lock screen mode is the system-wide one.
- Weather needs network access to api.open-meteo.com; it was only tested with the mock in the build container.
- "Pause when apps are maximized" does not detect a desktop entirely covered by several non-maximized windows.
