# Selene OS — Personalization

This document is the contract for every personalization feature: the settings keys, what applies them,
how visual styles and per-app themes work, and the profile system. Each area appends its
keys here when it implements them.

- **Area A:** theme engine, visual styles, typography, shape, scale, per-app themes, profiles and the
  Theme designer.
- **Area B1:** wallpaper engine — animated, dynamic (time of day, weather), slideshow, lock screen (§9).
- **Area B2:** taskbar, Start and Focus mode (§10).
- **Area B3:** cursor, icon and sound packs (§11); keyboard shortcuts and snap layout presets (§12).

Every area is implemented. §13 maps each item of the original request to the place that implements it and the test
that checks it; §14 is a French summary.

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
| `finish` | `'halo' \| 'prisme' \| 'sobre'` | `'halo'` | The theme (material of the whole shell, design/SYSTEM.md §9): `<html data-finish>`. `halo` = glass tinted by the wallpaper, colourful icons, petal-halo wallpapers; `prisme` = frosted glass with a faint grain, glossy icons, aurora veils; `sobre` = the flat Selene look. Settings files that never set it get `halo`. Choosing a theme moves the accent, the wallpaper and the icon set to the theme's own for the current style (`core/finishes.js` `finishDefaults(finish, style)`) unless the user changed them |
| `tintFromWallpaper` | bool | `true` | Halo and Prisme: windows, the bar and panels take the wallpaper's tint. No effect with transparency off, reduced transparency or High contrast (solid surfaces) |
| `style` | `'nocturne' \| 'eclipse' \| 'clairdelune' \| 'contrast'` | `'nocturne'` | Visual style: `<html data-style>` plus the style layer `core/styles/<style>.css`. Older ids (`win11`, `minimal`, `glass`, `retro`) and unknown ids are migrated to `nocturne` (settings.js `migrate()`, profile import) |
| `ambiance` | `null \| 'cold' \| 'neutral' \| 'warm'` | `null` | Colour mood of the surfaces and text: `<html data-ambiance>`. `null` = the style's own (Nocturne cold, Éclipse neutral, Clair de lune warm; `ambianceOf()`); choosing a style moves it along unless the user picked another one |
| `theme` | `'light' \| 'dark'` | `'dark'` | Colour mode: `<html data-theme>` |
| `autoTheme` | `{ enabled: bool, light: 'HH:MM', dark: 'HH:MM' }` | `{ enabled:false, light:'07:00', dark:'19:00' }` | **Auto** mode. theme.js writes `theme` at the two times, so every consumer keeps reading plain `'light'`/`'dark'`. It also applies the schedule when Auto is turned on (or its times change) and at boot. In between, a manual light/dark choice (quick settings, a profile) is kept until the next boundary |
| `accent` | `'#rrggbb'` | `'#c9d3e6'` | Accent colour → `--accent*` and `<html data-accent>`. The four Selene accents are `#c9d3e6` silver, `#6f8de6` night blue, `#a58bf2` violet, `#e9b566` amber, with curated dark / light values (`ACCENT_PRESETS`); any other hex is a custom colour (`data-accent="custom"`, computed shades). Follows the style unless the user picked another one |
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
| `taskbar.opacity` | `null \| 0–100` | `null` | `null` = follows `transparencyLevel`; a number fixes the taskbar alpha (`--a-taskbar`), clamped to 0.80–1 like all glass |
| `appThemes` | `{ [appId]: { theme: 'system'\|'light'\|'dark', accent: null\|'#rrggbb' } }` | `{}` | Per-app theme: see §3 |

Notes:

- **Visual styles have defaults and traits** (`STYLES` in theme.js):
  - every style: `noMica` (windows are flat; no blurred wallpaper copy is computed).
  - `nocturne`, `eclipse`, `clairdelune`: `defaults` = the ambiance, accent and wallpaper they bring. Choosing a style
    (`styleChoicePatch` / `chooseStyle`, or a plain `settings.set('style')`) moves each of them to the new style's
    default only if it still had the previous style's default value.
  - `contrast`: opaque, no blur, its own palette (ambiance and accent ignored), ignores `taskbar.color`.
- **Glass stays readable:** the alpha of the bar, the Lanceur and the panels is clamped to 80–92 % whatever
  `transparencyLevel` says (blur fails silently in software rendering); windows are always opaque.
- **Traits beat the sliders**, e.g. *transparency* has no effect in High contrast. Settings shows a note when a
  control is overridden by the style.

### 1.2 Areas B1–B3 keys

**B1 — wallpaper engine:** see §9 (`wallpaperMode`, `animatedWallpaper`, `dynamicWallpaper`, `slideshow`, `lockScreen`).

**B2 — taskbar, Start, Focus mode** (§10; pages `taskbar`, `start` in `pages/personalization-taskbar.js`, `focus` in
`pages/personalization-focus.js`)

| Key | Type | Default | Effect |
|---|---|---|---|
| `taskbar.size` | `'small' \| 'medium' \| 'large'` | `'medium'` | Thickness 40 / 48 / 56 px (vertical: 52 / 60 / 72 px), button size 32 / 40 / 48 px; icons and the clock scale |
| `taskbar.position` | `'bottom' \| 'top' \| 'left' \| 'right'` | `'bottom'` | Screen edge. Window insets, maximize / snap areas, flyouts, menus, toasts and desktop icons follow it |
| `taskbar.align` | `'center' \| 'left'` | `'center'` | Pre-existing. A vertical taskbar is always top-aligned |
| `taskbar.search` | `null \| 'hidden' \| 'icon' \| 'box'` | `null` | `null` = follows the older `taskbar.showSearch` (icon / hidden). `box` = Windows 11 search box (an icon on a vertical taskbar) |
| `taskbar.showSearch`, `taskbar.showTaskView`, `taskbar.showWidgets` | bool | `true`, `true`, `false` | Pre-existing buttons |
| `taskbar.widgetsPos` | `'auto' \| 'start' \| 'inline' \| 'end'` | `'auto'` | Widgets button: `start` = left end of a centred bar (with the "Widgets" label), `inline` = after Task view, `end` = before the tray. `auto` = `start` when centred, `end` when left-aligned (Windows 11 23H2). `start` falls back to `inline` on a left-aligned or vertical bar |
| `taskbar.tray` | `{ network, volume, battery }` (bool) | all `true` | Status icons next to the clock. With all three off the Quick settings button keeps a glyph |
| `showSeconds` | bool | `false` | Pre-existing (seconds in the taskbar clock); now also on the Taskbar page and in profiles |
| `taskbar.badges` | bool | `true` | Number of unread notifications of an app on its (first) button; cleared when they are read |
| `taskbar.hideDelay` | 0–5000 (ms) | `600` | How long an auto-hidden bar stays after the pointer leaves it (Settings: 0.3 / 0.6 / 1.2 / 2.5 s) |
| `taskbar.showLabels` | bool | `false` | App names next to the icons (running apps, horizontal taskbars) |
| `taskbar.combine` | `'always' \| 'whenFull' \| 'never'` | `'always'` | `always` = one button per app; `never` = one button per window; `whenFull` = one per window while they fit |
| `taskbar.widgets` | `('weather' \| 'cpu' \| 'memory' \| 'network')[]` | `[]` | Mini widgets in the tray, in this order |
| `taskbar.autohide` | bool | `false` | Pre-existing; now works on every edge |
| `taskbar.color`, `taskbar.opacity` | | | Area A (§1.1) |
| `start.layout` | `'default' \| 'morePins' \| 'moreRecommended' \| 'list'` | `'default'` | Pinned rows / recommended items: 3 / 6, 4 / 2, 2 / 8; `list` = one row of pins + the A–Z list of all apps |
| `start.background` | `'acrylic' \| 'glass' \| 'solid' \| 'accent' \| 'wallpaper'` | `'acrylic'` | Start background: translucent (follows transparency and blur), transparent glass (light veil + `--blur-lg`: follows the blur intensity; opaque with transparency off), opaque, tinted with the accent, or the blurred wallpaper (Mica) |
| `start.folders` | `string[]` | `[]` | Folder buttons next to the power button: `documents`, `downloads`, `music`, `pictures`, `videos`, `files`, `settings`, `home`, `network` |
| `start.groups` | `{ id: 'g-…', name, apps: appId[] }[]` | `[]` | App folders inside Pinned (two apps or more). A folder's place is its id inside `startPinned`; folders not placed there come first |
| `start.showRecentApps` | bool | `true` | Recommended shows apps added in the last 7 days (first seen by Start, `storage shell/start-usage.json` → `seen`); All apps marks them "New" |
| `start.showMostUsed` | bool | `false` | Recommended shows the apps launched most (two launches or more; launch counts in the same file) |
| `startShowRecent` | bool | `true` | Pre-existing: recently opened files in Recommended. The section is hidden when this is off and there is no app to recommend |
| `startPinned`, `pinned` | `appId[]` | | Pre-existing pinned lists (Start, taskbar). They are *content*, edited on the pages, and **not** part of profiles |
| `focusMode` | `{ active, hideNotifications, dimDesktop, dimLevel 0–100 (applied up to 90), hideIcons, simplifyTaskbar, duration 0–1440 min (0 = until off), endsAt (ms, 0 = until off), prevDnd (null \| bool) }` | `{ active:false, hideNotifications:true, dimDesktop:true, dimLevel:40, hideIcons:false, simplifyTaskbar:true, duration:0, endsAt:0, prevDnd:null }` | Focus mode (§10.3). `active`, `endsAt` and `prevDnd` are runtime state (excluded from profiles); a session survives a restart until `endsAt` |

**B3 — packs and input** (§11, §12; pages `cursors`, `iconPacks`, `soundPacks` in `pages/personalization-packs.js`;
`shortcuts`, `snapPresets` in `pages/personalization-input.js`)

| Key | Type | Default | Effect |
|---|---|---|---|
| `cursorPack` | `'default' \| 'classic' \| 'midnight' \| 'accent' \| 'large' \| 'highvis' \| 'retro'` | `'default'` | Mouse pointer pack (`default` = the system cursors) |
| `cursorSize` | 100–300 (%) | `100` | Pointer size for every pack; the system pack cannot grow, so above 100 % it is drawn as "Selene light" |
| `iconPack` | `'auto' \| 'halo' \| 'prisme' \| 'selene' \| 'tiles' \| 'accent' \| 'glass' \| 'graphite' \| 'mono' \| 'outline' \| 'retro'` | `'auto'` | `auto` = the icon set of the theme (`halo` → Halo, `prisme` → Prisme, `sobre` → Selene; read from `<html data-finish>`). App icons everywhere in the shell (+ Ordinateur / Corbeille, file-type icon tints; `selene` = the Selene icons in the colours of the current ambiance and mode, §11.2; a saved `fluent`, the old id, is read as and migrated to `selene`) |
| `soundPack` | `'aurora' \| 'chimes' \| 'retro' \| 'soft' \| 'silent'` | `'aurora'` | Scheme of every system sound (`silent`: only alarms ring) |
| `soundEvents` | `{ notification, startup, shutdown }`, each `null \| 'none' \| '<pack>.<sound>' \| '/abs/file.ogg'` | all `null` | Per-event sound. `null` = the pack's sound. Files: `.ogg .oga .opus .wav .mp3 .flac .m4a .webm` |
| `soundVolume` | 0–100 | `100` | Volume of the system sounds (pack tones and sound files) |
| `startupSound` | bool | `true` | Play the startup sound when the session starts |
| `sounds` | bool | `true` | Pre-existing master switch of system sounds (**not** `sounds.*`) |
| `snapPresets` | `{ id, name, zones: [{ x, y, w, h }], spec? }[]` (fractions 0–1 of the work area, ≤ 16 zones; `spec` = how the editor built it) | `[]` | Custom snap layouts (§12.2); a preset with no valid zone is dropped on profile import |
| `snapLayouts` | `null \| id[]` (built-in ids and preset ids) | `null` | Which layouts the snap flyouts show, in order (≤ 18). `null` = the six Windows 11 layouts, then every preset |
| `multitasking.snapBar` | bool | `true` | Layouts bar when a window is dragged to the top of the screen (next to the pre-existing `multitasking.snap / snapLayouts / snapAssist`) |
| `shortcuts` | `{ [actionId]: combo \| null }` | `{}` | Overrides of the shell shortcuts (§12.1). Missing = default combo, `null` = turned off |

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

- The Selene styles have no Mica (`noMica`): no blurred copy of the wallpaper is computed and `--mica-image` is
  `none`. For a style without that trait, the Mica copy is computed once per wallpaper, blur or style change, on a 320 px
  canvas. The wallpaper is decoded once and cached as a ≤ 640 px canvas. A blur or style change on the same
  picture re-blurs it 160 ms after the last change, so dragging the blur slider costs one re-blur, not one per step.
- Real `backdrop-filter` is used only on small surfaces (taskbar, flyouts, menus, toasts). Windows
  never use a live backdrop blur, even in the Glass style: their translucency shows the pre-blurred
  wallpaper (Mica).
- theme.js remembers the window last clicked / hovered (so menus and tooltips get its per-app theme) and forgets it as
  soon as that window leaves `#windows`: a closed window is never kept alive (checked with a forced GC in
  `test/personalization-core.test.mjs --only=e2e`).

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

The token contract for components is [design/SYSTEM.md](design/SYSTEM.md). theme.js loads every style sheet at boot,
along with `base.css`, which holds the shared effects:

- blur intensity on the feature surfaces;
- line heights scaled by `--text-scale`.

Each style is written inside `@scope ([data-style="<id>"])`, so it applies to `<html>` and to any element
carrying `data-style`. The style cards in Settings use this to render real mini-previews. The closest
`data-style` wins (scope proximity). The three Selene styles set **tokens and structural hooks only**
(`--bar-mode`, `--bar-margin`, `--win-border-w`, `--sel-bar-w`, `--panel-grain`…; SYSTEM.md §3); the
components read them.

| Style | Look | Defaults |
|---|---|---|
| `nocturne` (default) | Ink-blue night, floating bar islands, hairline window borders, 10 px windows | cold, silver, `builtin:nocturne` |
| `eclipse` | Graphite, full-width opaque bar, borderless windows with a soft shadow, accent bar on selected rows, 8 px windows | neutral, amber, `builtin:eclipse` |
| `clairdelune` | Warm night and cream, three floating pills, soft wide shadows, 8 px windows, light grain on the panels | warm, violet, `builtin:clairdelune` |
| `contrast` | High contrast. Dark: black, white text, yellow and cyan focus and links. Light: white, black text, dark blue and purple. Opaque, thick borders, text contrast ≥ 7:1 (WCAG AAA) | its own |

In every style, the bar's app icons are centred. The ambiances (cold, neutral, warm) are palettes of
`tokens.css` (`--amb-d-*` / `--amb-l-*`), independent of the style. Every text / surface pair is ≥ 4.5:1,
checked by `test/personalization-core.test.mjs` for 3 ambiances × 2 modes × 4 accents.

Settings: the Visual style page shows the four styles as cards with a CSS-drawn preview (window, bar shape,
accent), then the ambiance (Froide, Neutre, Chaude) and the four accent swatches (+ custom colour). The Theme
designer and the Colors page have the same ambiance and accent controls. All are keyboard accessible (one Tab
stop per group, arrows move).

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
- `focusMode` (without `active`, `endsAt`, `prevDnd`);
- packs, `soundEvents`, `snapPresets`, `shortcuts`, `desktopIconSize`, `appThemes`.

`PROFILE_EXCLUDE` lists sub-keys that are never saved (`focusMode.active`, `focusMode.endsAt`, `focusMode.prevDnd`). **Later areas append their new keys to
`PROFILE_KEYS`.**

**Complete round trip** (`test/personalization-core.test.mjs --only=e2e`): every `PROFILE_KEYS` key is changed, saved
as a profile, reset to its default, then the profile is applied with one click: all keys come back identical (with
`accentFromWallpaper` on, the accent is derived from the picture on screen, so it is compared once the wallpaper rests).
The same test checks that every key listed in the tables of §1 and §9.1 is in `PROFILE_KEYS` (except the pinned lists
and the `sounds` master switch, which are content / a system switch, not part of a look).

**Storage:** user profiles are stored with `storage:get/set('shell', 'profiles')` as
`{ version: 1, profiles: [...] }`.

**Applying:** one `settings:setMany` call. A key missing from a user profile is reset to its default. The
call runs inside `theme.transition()`, a ~300 ms cross-fade.

**Built-in profiles** only set the *look* keys (`LOOK_KEYS`, which include `finish` and `tintFromWallpaper`). They
never touch accessibility (`textScale`, `scale`, `reducedMotion`, `animations`) or layout keys. The built-ins are:

- Halo (`halo`) and Prisme (`prisme`): the theme in Nocturne, dark, its own accent and wallpaper (read from
  `core/finishes.js` `finishDefaults`), the automatic icon set, tint on
- in the Sobre theme (`finish: 'sobre'`): Nocturne (`aurora-dark`) and Nocturne clair (`aurora-light`), Éclipse
  (`eclipse`), Clair de lune (`clairdelune`)
- Contraste élevé (`contrast`)

A saved or imported profile with an older style (`win11`, `minimal`, `glass`, `retro`) gets `nocturne`.

**Export and import:**

- **Export** writes `{ format: 'aurora-profile', version: 1, name, values }`.
- **Import** validates it:
  - file ≤ 256 KB, right format and version;
  - unknown keys are dropped;
  - every value is checked against the key's type and range. Every key in `PROFILE_KEYS` has a validator in
    `VALIDATORS`:
    - identifiers (pack, widget, app, folder ids) must be slugs (`[a-z0-9._-]`);
    - names inside values (Start app folders, snap layouts, the location) are bounded and stripped of control characters
      and `<>`; the profile's own name keeps the text as typed (bounded, no control characters) and is only ever shown
      with `textContent`;
    - colours must be `#rrggbb` and fonts / styles / effects one of the known ids, so nothing imported can reach CSS
      as free text (checked: an accent `#fff;}*{display:none}` or a font `Inter";}…` is dropped);
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

- **Thème** (`section: 'finish'`, module `pages/personalization-finish.js`): three large cards, Halo, Prisme and
  Sobre, with a preview picture (`shell/renderer/assets/finishes/<id>.jpg`, 640 × 360, made from the mockups and from
  a screenshot of the Sobre look). The current one is marked; the group is one Tab stop (arrows, Home / End move;
  Enter / Space choose). A card only writes `settings.finish`; theme.js and finishes.js apply the theme's defaults.
- **Personnaliser le thème** (`section: 'customizeTheme'`), right under it, with the existing keys and builders:
  style (four buttons, `chooseStyle`), ambiance, accent (the theme's own three accents, then the four Selene ones,
  then a custom colour), wallpaper (thumbnail + link to Background), window transparency (`transparencyLevel`), blur,
  « Teinter les fenêtres selon le fond d'écran » (`tintFromWallpaper`; greyed out, with a note, in Sobre, with
  transparency off and with Contraste élevé, where every surface is solid) and the icon set (« Automatique (suit le
  thème) », Halo, Prisme, Selene, then the other packs; link to Icon packs). Search: « Thème », « Halo », « Prisme »,
  « Sobre », « Personnaliser le thème », « Teinter les fenêtres… », « Jeu d'icônes du thème »;
- **Theme designer** (`themeDesigner`);
- **Visual style** (`visualStyle`);
- **Profiles** (`profiles`);
- **App themes** (`appThemes`);
- Background (module `personalization-wallpaper.js`, area B1, §9.6);
- Colors;
- Themes;
- Lock screen (module `personalization-wallpaper.js`, area B1);
- **Animated & dynamic wallpapers** (`wallpaperEffects`, area B1);
- **Taskbar** and **Start** (module `personalization-taskbar.js`, area B2, §10.4);
- **Focus mode** (`focus`, module `personalization-focus.js`, §10.3);
- **Cursors**, **Icon packs**, **Sound packs** (`cursors`, `iconPacks`, `soundPacks`, module `personalization-packs.js`, §11);
- **Keyboard shortcuts** and **Snap layouts** (`shortcuts`, `snapPresets`, module `personalization-input.js`, §12).

No page is a stub any more. The B2/B3 pages share `pages/personalization-shell-kit.js` (`setupShellPages`, `boundCombo`,
`boundSeg`, `boundToggle`, `orderedList`, `appIcon`) and `pages/personalization-shell.css` (classes `pzs-*`), with
their strings in `apps/settings/i18n.json` → `pzs` (English and French).

**Accessibility** reuses the same control builders (`textSizeControls`, `motionControls` exported by
`pages/personalization-designer.js`), so each setting has a single source of truth:

- **Text size** has the text size and the UI scale.
- **Visual effects** has transparency, animations and reduced motion.

### Adding a personalization page or key

1. Add or extend the module (`pages/personalization-wallpaper.js`, `personalization-taskbar.js`, `personalization-focus.js`,
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
  defaults (`/etc/aurora/settings.json`), not the user's. The same holds for its cursors, icons and sounds.
- Limitations of the wallpaper engine: §9.8; of the taskbar, Start and Focus mode: §10.5; of the packs: §11.4; of
  shortcuts and snap layouts: §12.3.

## 9. Wallpaper engine (area B1)

Animated wallpapers, dynamic wallpapers (time of day and weather), the slideshow and the lock screen background.

### 9.1 Keys

| Key | Type / range | Default | Effect |
|---|---|---|---|
| `wallpaperMode` | `'static' \| 'animated' \| 'dynamic' \| 'slideshow'` | `'static'` | `static` = the picture or solid colour of `wallpaper` (drawn by `core/desktop.js`); the other modes are drawn by `core/features/wallpaper.js` |
| `animatedWallpaper` | `{ id, speed 0–100, intensity 0–100, fps 15\|30, pauseOnMaximized }` | `{ id:'aurora', speed:50, intensity:50, fps:30, pauseOnMaximized:true }` | `id`: `aurora`, `bloom`, `fluid`, `bokeh`, `starfield`, `waves`. Speed 50 = ×1 (0 = ×0.2, 100 = ×2.5). Intensity = brightness / amount of detail of the effect |
| `dynamicWallpaper` | `{ source: 'time'\|'weather', set: 'lake'\|'dunes'\|'peaks', location: null\|{ name, lat, lon }, followTheme }` | `{ source:'time', set:'lake', location:null, followTheme:false }` | Time-of-day set; `weather` adds the current weather; `location: null` = fixed day 07:00–19:00; `followTheme` writes `theme` (light from sunrise to sunset) unless `autoTheme.enabled` |
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
  lake, with reflection), `bloom` (the Selene flower: petals sway and breathe, a light band glides over the glass; in the
  accent colour), `fluid` (mesh gradient in the accent colour), `bokeh` (drifting soft lights with parallax), `starfield`
  (Milky Way, twinkling stars, shooting stars), `waves` (layered swells in the accent colour). Light and dark variants.
- **Measured cost** (1600×900 desktop, software rendering, 4-core container shared with other test runs; checked by
  `test/wallpapers.test.mjs --only=perf`, budget 18 ms per frame and 40 % of the main thread): fluid, bokeh, night sky and
  waves 0.1–0.7 ms per frame (≈ 1 %); bloom ≈ 12 ms (≈ 27 %); aurora ≈ 18 ms (≈ 33 %) at the frame rate the loaded
  machine reached. Aurora draws its curtains at ⅓ of the screen resolution with ≈ 250 additive sprite draws per frame and
  bloom at 0.4 (before: ½ resolution, 77 ms and 38 ms per frame on the same machine). 15 fps halves the cost; 0 when
  paused. Waves draws each swell as one smooth path (quadratic curves through 48 points).
- **No leaks** (same test): 20 switches between static and animated, effect changes and lock / unlock leave one scene,
  the same number of canvases and DOM elements, the same requestAnimationFrame rate, a stable JS heap after GC, and every
  replaced still frame (blob: URL) revoked. Lock-screen still frames are cached for the 4 most recent effect / accent /
  size combinations; older ones are revoked.

### 9.3 Dynamic wallpaper

- **Sets** (`core/wallpaper/dynamic.js` `DYNAMIC_SETS`): `lake` (Lac sous la lune), `dunes` (Dunes sous la lune) and
  `peaks` (Cimes), each with dawn / day / dusk / night pictures. Dawn and night are the static pictures of the same scene
  (`nocturne-light/-dark`, `clairdelune-light/-dark`, `peaks-light/-dark`); day and dusk are
  `renderer/assets/wallpapers/dynamic/<set>-<phase>.jpg` (`xvfb-run -a node tools/gen-wallpapers.mjs --only=dynamic`).
  An unknown set id (for example the retired `bloom`) falls back to `lake`. See §9.9 for the whole picture set.
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
  online results; `samePlace(a, b)` (same name, within ~25 km) keeps a built-in city that the online search already
  lists from appearing twice.
- Words and icons for conditions: `core/wallpaper/weather-text.js` — `weatherDescribe(conditions, lang)` (EN / FR),
  `weatherIconName(conditions)` (Fluent icon, day / night aware), `formatTemperature(conditions, formatNumber)`. Use it
  in any new consumer instead of copying the strings.
- **Consumers today:** the dynamic wallpaper (§9.3); the taskbar weather mini-widget (`core/taskbar.js`, area B2);
  the **widgets board** weather card (`core/features/widgets.js`: temperature, description, place and update time from
  `weather:current` with no place = the dynamic wallpaper's location; without a location it offers "Choose a location",
  which opens Settings > Animated & dynamic wallpapers > Location; offline it keeps its placeholder).
- **Testing without network**: `AURORA_WEATHER_MOCK=/path/mock.json` replaces the HTTP requests; the file is re-read on
  every request: `{ "offline": false, "delayMs": 0, "current": { "weather_code": 61, "is_day": 1, "temperature_2m": 12 },
  "geocoding": [ … ] }`. `AURORA_WEATHER_TIMEOUT` (ms) shortens the timeout.

### 9.5 Slideshow and lock screen

- **Slideshow**: the pictures of `slideshow.folder` (jpg, png, webp, avif, gif, bmp; sorted, or shuffled once a day), a new
  one every `interval` minutes with the 4 s cross-fade; `shell.emit('wallpaper:next')` skips to the next one (Settings
  "Next picture"). An empty or missing folder falls back to the built-in pictures.
- **Picture of the day** (`spotlightPick(date)` in `core/wallpaper/dynamic.js`): the 17 built-in pictures in a fixed
  order in which two consecutive days — wrap-around included — never show the same family (lake, dunes, peaks,
  eclipse, forest, Milky Way).
- **Lock screen** (`core/wallpaper/lock.js`): `core/features/lock.js` asks `ctx.wallpaperEngine.lockWallpaperUrl()` for the
  picture and calls `ctx.wallpaperEngine.attachLock(ls)` (both additive). Animated mode (or "same as the desktop" while
  the desktop is animated) runs the scene inside the lock screen's picture; it stops on the sign-in view, when the screen
  is dismissed, and with reduced motion. The blurred sign-in view uses a still frame of the scene.
- **Sign-in screen** (`core/greeter/greeter.js`, additive): the same three modes, from the settings it can read (the system
  defaults, `/etc/aurora/settings.json`).

### 9.6 Settings pages (`apps/settings/pages/personalization-wallpaper.js` + `.css`, strings `wp.*`)

- **Background** (`background`): live desktop preview and status ("On your desktop now"), and *Personalize your
  background*: Picture / Solid color / Slideshow / Animated / Dynamic (time of day), each with its own controls.
  Slideshow: album folder (Browse, and *Use Selene pictures* while a folder is chosen), interval, shuffle, *Next
  picture*, fit. Sun times use the taskbar clock's format (two-digit hours with a 24-hour clock: "Lever 06:04").
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

### 9.9 Built-in pictures (Selene lunar set)

Original artwork drawn procedurally by `shell/tools/gen-wallpapers.mjs` (Canvas 2D in an offscreen Electron window,
seeded, no external images): `xvfb-run -a node tools/gen-wallpapers.mjs` renders every picture and the contact sheet
`docs/design/wallpapers-sheet.jpg`; `--only=<name,…>`, `--only=dynamic`, `--scale=0.5 --out=<dir>` and `--sheet-only`
are available. Every file is a 2560×1440 JPEG (q 0.88, under 1.2 MB, checked by `test/wallpapers.test.mjs`), with a
fine grain on every gradient so nothing bands. The bottom of each picture stays calm and dark (or evenly light) where the
bar sits.

| Id (`builtin:<id>`) | Name (fr / en) | Light | Dark |
|---|---|---|---|
| `nocturne` (Nocturne style) | Nocturne | `nocturne-light.jpg`: the lake at dawn, a pale full moon setting | `nocturne-dark.jpg`: full moon low over a calm lake, reflection, faint stars |
| `eclipse` (Éclipse style) | Éclipse / Eclipse | `eclipse-light.jpg`: white disc and amber halo on a pale sky | `eclipse-dark.jpg`: black disc, thin cream ring, amber corona, fine grain |
| `clairdelune` (Clair de lune style) | Clair de lune / Moonlight | `clairdelune-light.jpg`: phases arc over dunes, lavender and peach dawn | `clairdelune-dark.jpg`: phases arc over dunes, warm night |
| `forest` | Forêt de pins / Pine forest | `forest-light.jpg`: pines in the morning mist | `forest-dark.jpg`: moonlit pine forest |
| `peaks` | Cimes / Peaks | `peaks-light.jpg`: alpenglow at dawn | `peaks-dark.jpg`: mountains under a crescent with earthshine |
| `milkyway` | Voie lactée / Milky Way | `milkyway.jpg` | `milkyway.jpg` |

The ids of the retired set (`bloom`, `glow`, `flow`, `sunrise`, `aurora`, `dunes`) are no longer in `WALLPAPERS`:
`resolveWallpaper('builtin:<old id>')` returns the first entry (Nocturne), so old settings and profiles still show a
picture. The moons follow the real near side (maria kept low in contrast and broken up, so no face appears).

### 9.10 Finish pictures (Halo, Prisme)

The Halo and Prisme finishes (`core/finishes.js`, `finishDefaults(finish, style).wallpaper`) bring one picture per style,
each with a light and a dark variant that follow the mode like the Selene set. They are drawn by
`shell/tools/gen-finish-wallpapers.mjs` (Halo: procedural SVG rasterised by Electron; Prisme: numpy, in
`tools/gen-finish-wallpapers.py`; both ported from `docs/design/mockups-mix/*/build/`, seeded):
`xvfb-run -a node tools/gen-finish-wallpapers.mjs [--only=halo-eclipse-light,…] [--out=<dir>]` (needs python3 with
numpy and Pillow). Every file is a 2560×1440 progressive JPEG (q 88, under 700 KB, Gaussian dither against banding;
checked by `test/wallpapers.test.mjs --only=finish`). The twelve files add about 3.6 MB to the image. In the
Background and Lock screen grids the current finish's pictures come first (`wallpaperChoices()`, read from
`<html data-finish>`: then Halo, Prisme and the Selene set, which Sobre keeps using and lists first); the Spotlight
rotation includes them.

| Id (`builtin:<id>`) | Name (fr / en) | Light | Dark |
|---|---|---|---|
| `halo-nocturne` | Halo bleu / Blue halo | blue / cyan petals on an ice-blue sky | blue / indigo / cyan petals around a glowing core, navy |
| `halo-eclipse` | Couronne d’or / Golden corona | amber / gold petals around a pale sun disc, cream | amber / gold corona around a black disc |
| `halo-clairdelune` | Pétales d’aube / Dawn petals | violet / pink / peach petals on lavender | the same flower on deep violet and plum |
| `prisme-nocturne` | Aurore boréale / Northern lights | cyan / blue / violet veils on a pale dawn sky, white moon | aurora curtains, small moon, stars, navy |
| `prisme-eclipse` | Voiles d’or / Golden veils | gold / copper / magenta veils on cream, eclipse with a gold ring | gold / copper / magenta silk veils, eclipse with corona |
| `prisme-clairdelune` | Aube rose / Pink dawn | lavender / pink / peach mesh sky, crescent | the same veils at night: violet to plum, crescent, stars |

## 10. Taskbar, Start and Focus mode (area B2)

Runtime: `core/taskbar.js`, `core/start.js`, `core/features/focus.js`; CSS: `core/shell-personalize.css` (layout, shared),
`core/taskbar-start.css` (B2: badges, widgets place, vertical flyout anchoring, Start glass, folder popup, recommended
apps; loaded by taskbar.js) and `core/features/focus.css` (icons, banner, tray chip). Test: `test/taskbar-start-focus.test.mjs`.

### 10.1 Taskbar (`core/taskbar.js`)

- **Layout attributes.** `applyLayout()` sets `<html data-tb-pos="bottom|top|left|right" data-tb-size="small|medium|large"
  data-tb-labels="on|off">` and `--taskbar-h` (the thickness: 40 / 48 / 56 px, vertical 52 / 60 / 72 px), then tells the
  window manager the reserved edge with `wm.setInsets({ top, bottom, left, right })`. Maximized and snapped windows, the
  snap zones, the desktop icons, toasts, the volume / brightness OSD, the Task view pill and every flyout (Start, Search,
  Quick settings, Calendar, Widgets) follow the edge. Flyouts slide in from it; on a vertical bar Start and Search open
  at the top (next to the Start button) and Quick settings / Calendar at the bottom (next to the tray), using the whole
  screen height, and never wider than the space left beside the bar (a 800 px Search panel on a 1024 × 768 screen at
  125 %). Menus and the window picker open above, below or beside the button (`menuPointFor(el)`, `placePopup()`); Win+X
  opens next to the Start button.
- **Vertical taskbar** (left / right): the buttons stack from the top (the Start button first, then search, task view,
  widgets, apps), the tray and a compact clock (time only) sit at the bottom, arrow keys move Up/Down, the search box
  becomes an icon and app names are hidden. The clock's font follows the text size only as far as "00:00" fits the
  bar's width; seconds and AM/PM wrap onto a second line.
- **Clock and text size:** on a horizontal bar the two-line clock grows with the text size but stays inside its 32 / 40
  / 48 px button (`core/taskbar-start.css`: `calc()` line heights, which theme.js does not rescale).
- **Buttons per app or per window.** Every button has a key `appId` (combined) or `appId::winId` (one per window).
  `whenFull` keeps one button per window while `capacity(keys)` says they fit, then combines. Dragging buttons to
  reorder the pinned apps works when buttons are combined (`always`). The overflow ("…") flyout and the keyboard
  navigation use the same keys.
- **Labels.** `showLabels` shows the window title (or the app name) of running apps in a 132–168 px button with an
  ellipsis; with `combine: 'never'` this is Windows 11 23H2's "Never combine". The running / active indicator always sits
  on the side of the button that faces the screen edge.
- **Badges** (`taskbar.badges`): the number of unread notifications of an app (1–9, "9+") on its first button, in the
  accent colour (High contrast: its highlight colours); also read by screen readers in the button name.
- **Tray icons** (`taskbar.tray.network|volume|battery`, `showSeconds`).
- **Widgets button** (`taskbar.widgetsPos`): see §1.2.
- **Mini widgets** (`taskbar.widgets`, before the tray icons): `cpu` and `memory` (meter + %, `sys:stats` every 3 s),
  `network` (↓/↑ throughput computed from `sys:stats` byte counters), `weather` (temperature and condition icon from
  `weather:current` with the place of *Animated & dynamic wallpapers*, refreshed every 15 min). Polling stops while the
  window is hidden or no widget is shown. Clicking a meter opens Task Manager (Performance); the weather opens the
  widgets board.
- **Auto-hide** works on each edge: the bar slides out of the screen after `taskbar.hideDelay` ms, a 3 px hot zone on
  that edge brings it back, it stays visible while a menu or flyout of it is open or it has the keyboard focus, and the
  work area takes the whole screen.
- **Right-click** on an empty part of the bar: Task Manager, **Taskbar settings** (Settings → Taskbar).
- **Only real changes re-lay the bar.** A `settings:setMany` of other keys (profiles, Focus mode, theme) reaches every
  listener; taskbar.js compares the `taskbar` object and rebuilds only when it changed.
- **API:** `taskbar.layout()` → `{ position, size, vertical, thickness, combine, labels }`; `taskbar.setStatusItem(id, {
  icon, text, tip, onClick } | null)` adds a tray chip (Focus mode uses it); `taskbar.refreshWidgets()`. Event
  `taskbar:layout` (payload `layout()`) after any change of edge, size or alignment; `core/desktop.js` re-lays the
  desktop icons on it.
- **Clock:** a 24-hour clock always shows two-digit hours ("00:55", like Windows in French); 12-hour stays "12:55 AM".

### 10.2 Start (`core/start.js`)

- **Layout** (`start.layout`): rows of pinned apps / number of recommended items — `default` 3 / 6, `morePins` 4 / 2,
  `moreRecommended` 2 / 8; `list` shows one row of pins and the A–Z list of all apps instead of Recommended. Without a
  Recommended section the grid gets 6 rows.
- **Pinned apps** (`startPinned`): right-click → Move to front / Unpin / Pin to taskbar / Add to folder; drag a tile and
  *rest* over the edge of another one to make room (reorder), drop it on the taskbar to pin it there. Sweeping across
  tiles does nothing: the pointer must rest 160 ms (reorder) or 450 ms (folder) within 6 px. The Start page in Settings has
  the same list with Up / Down / Remove and "Pin an app" (moving an app keeps folders where they are).
- **App folders** (`start.groups`, Windows 11 22H2):
  - **create:** hold a dragged app over the middle of another app → the target shows a folder frame → drop: a folder
    "Folder" with both apps takes the target's place. Keyboard: right-click / menu key → Add to folder › New folder with ›
    app (opens the new folder with its name selected). Settings → Start → App folders → New folder (two apps or more).
  - **tile:** a 2 × 2 mini grid of the first four apps; drop an app on it to put it inside; folders can be dragged to
    reorder them; F2 renames.
  - **open:** click / Enter → a popup over the Pinned page that grows out of the tile (the page is dimmed and inert, so
    Tab stays in the popup); arrows move between its apps, Up from the first row reaches the name; Esc, the ✕ or a click
    outside closes it; typing a letter goes to the search box.
  - **rename inline:** the folder name is an editable field at the top of the popup (Enter or leaving it saves, Esc
    restores; `<`, `>` and control characters are removed, 60 characters max).
  - **reorder / drag out:** drag inside the popup to reorder; drag an app *out* of the popup to take it out of the
    folder (it lands right after the folder).
  - **dissolve:** a folder needs two apps; when one is left it dissolves and that app takes the folder's place. Removing a
    folder (menu or Settings) puts its apps back where the folder was. Apps inside a folder stay in `startPinned` (hidden
    from the grid), so no pin is ever lost, even when a profile changes `start.groups`.
  - **API** (Settings uses it): `start.folders.list() / create(name, apps) / update(id, { name, apps }) / rename(id, name)
    / remove(id) / add(id, appId) / take(id, appId) / open(id, { rename }) / close()`.
- **Recommended:** recently added apps (`start.showRecentApps`), most used apps (`start.showMostUsed`) — at most half of
  the slots — then recently opened files (`startShowRecent`); "More" opens the full list. Settings → *Clear the list of
  recently opened files* calls `recent.clearFiles()`. `recent.markAdded(appId)` lets an installer mark a new app.
- **Folders next to the power button** (`start.folders`): Documents, Downloads, Music, Pictures, Videos, File Explorer,
  Settings, Personal folder, Network; each opens File Explorer at the place (or Settings).
- **Background** (`start.background`, `#start[data-bg]`): `acrylic` (default, follows transparency and blur), `glass`
  (transparent glass: light veil, `--blur-lg`, highlight edge; follows the blur intensity, opaque with transparency off),
  `solid` (opaque `--solid`), `accent` (translucent accent tint), `wallpaper` (the Mica copy of the wallpaper, with a veil
  for contrast). High contrast keeps its own palette whatever the style.
- **Position:** centred over a centred bottom bar, at the left of a left-aligned one, under a top bar, beside a vertical
  bar at the top of the screen.
- **One re-render per change:** `startPinned`, `start` and `startShowRecent` share one refresh (skipped when none of them
  changed); an open folder stays open and the keyboard stays on the same tile.

### 10.3 Focus mode (`core/features/focus.js`)

- **Turning it on / off:** Settings → Focus mode (Start session / End session), the *Focus* tile of Quick settings,
  Win+Shift+F (customizable action `focusMode`), the tray chip menu (End session, Add 10 minutes), or the shell events
  `focus:start` (`{ minutes }` optional), `focus:stop`, `focus:toggle`. API: `shell.focus` / `window.__aurora.focus` =
  `{ start(minutes?), stop(), extend(minutes), toggle(), state }`. It emits `focus:changed` `{ active, endsAt }`. A
  banner says "Focus session started — until 10:45 · notifications silenced" for 3.6 s; it gives way to Start, Search
  and the Widgets board (they reach the top of the screen) and is not shown while one of them is open.
- **What it does** (each part can be turned off on the page):
  - `hideNotifications` → **Do not disturb is turned on** (`notifications.dnd`, its previous value saved in
    `focusMode.prevDnd` and put back at the end — also when the option is switched off during a session) and `<html
    data-focus-quiet="on">`: `core/notify.js` keeps new notifications in the notification center without a banner or
    sound; the bell shows the snoozed glyph; taskbar badges and flashing buttons are hidden until the session ends (like
    the "hide badges / hide flashing" options of a Windows 11 focus session). Urgent notifications (alarms, timers)
    still ring.
  - `dimDesktop` → `<html data-focus-dim="on">` + `--focus-dim` (`dimLevel` / 100, max 0.9): a black veil over the
    wallpaper and desktop icons, faded in / out; windows stay bright.
  - `hideIcons` → `<html data-focus-noicons="on">`: the desktop icons fade away.
  - `simplifyTaskbar` → `<html data-focus-simple="on">`: no search, task view, widgets button or mini widgets; only Start,
    the running apps (pinned apps that are not running are hidden), the focus chip, the tray and the clock.
- **Session length** (`duration`, minutes; 0 = until turned off; Settings offers 15, 25, 30, 45, 50, 60, 90, 120): the
  tray chip shows the minutes left, a notification says when the session is over, and everything comes back.
  **Restarts:** `active`, `endsAt` and `prevDnd` are stored, so a session goes on after the shell restarts; one whose end
  time passed while the shell was not running is closed at start-up (Do not disturb restored, end notification). The
  chip's 30 s tick also compares the wall clock with `endsAt`, so a session whose end passed while the machine slept
  ends at wake-up (once: one end notification). They are never part of a profile.
- **Clock app:** the Focus page shows the Clock app's focus sessions (running / paused session and today's focus
  minutes, read from `storage clock/focus.json`; nothing is shown when the app or the file is missing) with an *Open
  Clock* button.

### 10.4 Settings pages

- **Taskbar** (`taskbar`): live preview; *Taskbar items*: Search (Hide / Search icon only / Search box), Task view,
  Widgets, Widgets button position; *Pinned apps* (order, remove, "Pin an app"); *System tray icons* (network, volume,
  battery, clock seconds); *Taskbar widgets* (weather, processor, memory, network speed); *Taskbar behaviors*: position,
  size, alignment (disabled when vertical), app names, combine buttons, badges, auto-hide, hide after (enabled with
  auto-hide); *Taskbar color* (Default / Accent / custom colour + opacity slider, shared with the Theme designer);
  *Reset the taskbar*. Right-click on the taskbar → Taskbar settings opens it.
- **Start** (`start`): live preview; *Layout* and *Background style*; *Pinned apps*; *App folders* (new / edit / remove,
  two apps or more); *Recommended*: recently added apps, most used apps, recently opened files, clear the list; *Folders
  next to the power button* (toggles); *Reset Start*.
- **Focus mode** (`focus`): status ring with Start / End session, time left and end time; hide notifications, dim the
  desktop + dimming slider, hide desktop icons, simplify the taskbar; session length; Clock focus sessions; the shortcut.

### 10.5 Known limitations

- A vertical taskbar is always top-aligned and shows icons only (no app names, search box as an icon).
- The weather widget needs a place (Settings → Animated & dynamic wallpapers) and network access to api.open-meteo.com;
  it was only tested with `AURORA_WEATHER_MOCK`.
- The network widget shows the whole machine's throughput (all interfaces), as reported by `sys:stats`.
- "Recently added" knows the apps Start has seen: on the first start every app counts as old; apps that arrive later (an
  update, `recent.markAdded`) are new for a week.
- Badges count shell notifications; apps cannot set a badge of their own yet.
- Start folders are created by drag-and-drop with the mouse or from the tile menu; touch drag is not supported.

## 11. Cursor, icon and sound packs (area B3)

### 11.1 Cursor packs (`core/packs.js`)

- **Packs:** System (`default`, the platform cursors), Selene light (`classic`, white with a black outline, 24 px),
  Midnight (black, white outline), Accent color (filled with the current accent, redrawn when it changes), Large (40 px),
  High visibility (yellow, black outline, 32 px), Retro pixel (pixel-art upscaled, 32 px).
- **How:** the first time a pack other than System is chosen, every plain cursor keyword of the loaded style sheets
  (`cursor: pointer`, `text`, `move`, `*-resize`, `grab`, `wait`, `not-allowed`…) is rewritten once through the CSSOM to
  `var(--cur-<keyword>, <keyword>)`; style sheets loaded later are rewritten too (MutationObserver on `<head>`). A pack
  only sets those variables in `style#aurora-cursor-vars` as PNG data URLs drawn on a canvas (with the right hot spot),
  plus the arrow on the root, an I-beam on editable fields and the hand on links. Buttons and form controls get the
  pack's arrow through a zero-specificity `:where(button, select, input[type=checkbox]…)` rule (Chromium's own style
  sheet gives them the system arrow; any author `cursor:` on them still wins). Cursors set from JavaScript as inline
  styles (`el.style.cursor = 'grabbing'`) are mapped to the same variables by a MutationObserver while a pack is drawn.
  System = no variables, so switching is instant and free.
- **Size:** `cursorSize` (100–300 %) scales every pack (slider on the Cursors page, live).
- **API:** `packs.cursorPreview(packId, shape)` → data URL (Settings cards); `<html data-cursor-pack>`.

### 11.2 Icon packs (`core/packs.js`)

- **Packs:** Selene (`selene`, the default: one symbol per app in a muted colour on a rounded square common to every
  app; the old id `fluent` maps to it), Selene tiles (the same
  symbol in white on a tile of the app's colour, darkened so white stays >= 4.5:1), Accent tiles (every tile in the accent colour, redrawn when it changes; the glyph is white or night blue #161d30, whichever contrasts more, since the Selene accents are light), Glass (glyph on a frosted rounded
  square), Graphite (monochrome tiles), Monochrome (`mono`, single-colour glyphs drawn for the system mode and inverted
  inside a window of the other mode), Outline (line glyphs, no tile), Retro pixel (48 px pixel-art PNG).
- **Selene follows the look:** the base and the symbol colours come from the ambiance and the mode
  (`core/app-icon-art.js`, the only table of icon colours): night blue with the cold palette (Nocturne), warm charcoal
  with stone, bone, heather, olive, moss, amber, sand, clay and copper symbols (neutral, Éclipse), plum with cream,
  lavender, mauve, sage, eucalyptus, honey, oat, rose and peach symbols (warm, Clair de lune). Neutral and warm have no
  blue cast and no blue or cyan symbol. Each app keeps its palette slot (`APP_GLYPHS[id].hue`) in every ambiance. Light
  mode keeps a dark tile one step lighter (it keeps its silhouette on the light bars); Contraste élevé draws a flat
  tile in the style's own colours (black, white edge and symbol; reversed in light mode). The SVGs are cached per look
  and redrawn when `<html data-ambiance | data-theme | data-style>` changes. The static `apps/<id>/icon.svg` files
  (generated by `tools/gen-app-icons.mjs`, which shares the drawing code) are the cold dark look, used by `.desktop`
  files, the docs and before the shell loads.
- **Special icons:** This PC, the Recycle Bin (desktop, File Explorer) and the default app icon (`app-default.svg`,
  Linux apps without an icon) follow the pack through a style sheet (`img[src$="this-pc.svg"] { content: url(…) }`),
  so pictures drawn from the apps' own icon files follow too.
- **How:** `registry.iconResolver(appId, manifest)` (an additive hook of `core/registry.js`) returns an SVG data URL
  built from the app's symbol (`core/app-glyphs.js`, generated with the icons; Phosphor 2.1.1, MIT), so every `registry.iconUrl()` caller (taskbar, Start, search, Alt+Tab, Task view,
  window title bars, Settings › Apps…) gets the pack's icon. Icons already on screen are swapped in
  place, and windows get `win.setIcon()`. File-type icons are tinted per pack with `<html data-icon-pack>`
  (`shell-personalize.css`).
- **API:** `packs.appIcon(packId, appId)` → URL (Settings previews).

### 11.3 Sound packs and event sounds (`core/sounds.js`)

- **Packs** (WebAudio synthesis, no audio files): Selene (the original sounds), Chimes (bell tones), Retro 8-bit
  (square waves), Soft (low triangle waves), Silent (nothing except alarms). Every system sound follows the pack:
  `notify`, `startup` (at sign-in, `core/boot.js`; `startupSound` off skips it), `shutdown` (sign out / restart / shut
  down wait for it, max 1 s, `core/services.js`), `logon`, `unlock`, `error`, `warning`, `click`, `screenshot`, `alarm`,
  `deviceConnect` / `deviceDisconnect` (drives plugged / unplugged), `emptyTrash` — 13 sounds × 5 packs.
- **Volume:** `soundVolume` (0–100 %) multiplies every pack tone and sound file.
- **Per event** (`soundEvents.notification | startup | shutdown`): the pack's sound (`null`), None (`'none'`), the sound of
  another pack (`'chimes.notify'`), or an audio file chosen with the file picker (an absolute path, played with
  `<audio>` through `api.mediaUrl`). The `sounds` switch still turns every system sound off.
- **API:** `sounds.play(name | pattern)`, `await sounds.playAndWait(name, maxMs)`, `sounds.preview(ref, name)` (plays
  even when sounds are off, for Settings), `sounds.choices(event)`, `SOUND_PACKS`, `SOUND_EVENTS`. `sounds.play()` keeps
  its old signature (apps pass tone patterns; `sanitizePattern` is unchanged).

### 11.4 Known limitations

- Cursor packs do not apply inside web pages (browser tabs, `<webview>`); those keep the system cursor. CSS cursors
  cannot be animated, so *Busy* / *Working* are a static frame.
- Icon packs change the icons the shell draws from the registry; an app that draws its own icons inside its window
  (e.g. a toolbar) keeps them.
- Sounds were checked by counting oscillators in tests (the build container has no audio device); they were not listened
  to there.

## 12. Input: keyboard shortcuts and snap layouts (area B3)

### 12.1 Keyboard shortcuts (`core/shortcuts.js`, `core/features/hotkeys.js`, `main/lib/hotkeys.js`)

- **Catalog** (`SHORTCUTS`, 46 actions in 5 groups, plus the user's own "open this app" actions `app:<appId>`, ≤ 40):
  - *Desktop and Start:* start (Win), search (Win+S), quickSettings (Win+A), notifications (Win+N), widgets (Win+W),
    showDesktop (Win+D), lock (Win+L), run (Win+R), powerMenu (Win+X), clipboard (Win+V), emoji / emojiAlt (Win+. /
    Win+;, the emoji and symbols panel, core/features/emoji.js), focusMode (Win+Shift+F),
    screenshot (Win+Shift+S).
  - *Windows:* taskView (Win+Tab), snapLayouts (Win+Z), snapLeft / snapRight (Win+←/→), maximize (Win+↑),
    minimize (Win+↓), maximizeVertically (Win+Shift+↑), minimizeAll (Win+M), restoreAll (Win+Shift+M),
    minimizeOthers (Win+Home), windowMenu (Alt+Space), closeWindow (Alt+F4).
  - *Virtual desktops:* newDesktop (Win+Ctrl+D), closeDesktop (Win+Ctrl+F4), prevDesktop / nextDesktop
    (Win+Ctrl+←/→).
  - *Taskbar apps:* taskbarApp1…9 (Win+1…9: open or switch to the n-th taskbar app).
  - *Apps:* files (Win+E), settings (Win+I), terminal (Ctrl+Alt+T), taskManager (Ctrl+Shift+Esc), browser, notepad,
    calculator (no default), accessibility (Win+U), display (Win+P); *Add an app* creates `app:<appId>` (open the app,
    or switch to its latest window).
- **Fixed combos** (never rebound or taken): Alt+Tab, Alt+Shift+Tab, Ctrl+Alt+Tab, Ctrl+Alt+Delete, PrintScreen, the
  volume / brightness keys. **Reserved** (the X server takes them): Ctrl+Alt+F1…F12, Ctrl+Alt+Backspace.
- **Valid combos** (`comboProblem(combo)`): modifiers in the order Super, Ctrl, Alt, Shift, then one key; it must
  contain Win, or Ctrl+Alt together, or be F13–F24 — so Ctrl+C, Alt+F or Shift+A always keep reaching the apps. The
  catalog's own defaults (Alt+Space, Alt+F4, Ctrl+Shift+Esc) stay allowed; "Win" alone is allowed. Rebinding an
  action frees its default combo (e.g. taskbarApp1 on Ctrl+Alt+1 leaves Win+1 unbound).
- **Live map:** `features/hotkeys.js` rebuilds combo → action from `effectiveShortcuts(settings.shortcuts)` whenever the
  key changes. Combos containing Win are always forwarded by the main process; other custom combos (e.g. Ctrl+Alt+E) are
  sent to it with `hotkeys:setCustom` (the main process accepts only Ctrl+Alt combos or F13–F24) so they also work
  while a browser tab has the focus.
- **Settings → Keyboard shortcuts:** search box, the four groups with key caps (French names: Maj, Échap, Suppr…),
  *Change* opens a recorder: `shell.hotkeys.capture(fn)` receives the next key combination before any shortcut runs
  (keys without Ctrl, Alt or Win keep working in the dialog — Tab, Enter, Esc to cancel — and a letter alone is shown
  with "Add Win, Ctrl or Alt to the key"). The combo is checked live; one already used by another action shows "Already used by
  …: saving turns it off there". The *…* menu turns a shortcut off or restores its default; *Restore all shortcuts*;
  the fixed shortcuts are listed for reference.

### 12.2 Snap layout presets (`core/features/snaplayouts.js`, `core/wm.js`)

- A preset is `{ id, name, zones: [{ x, y, w, h }] }` in fractions of the work area (up to 16 zones, inside the
  screen). `presetZones(p)` turns it into zone names `z:x,y,w,h`, which `wm.zoneRect()` understands (additive), so a
  custom zone snaps like a built-in one (keyboard, Snap Assist, restore).
- **Built-in catalog** (`BUILTIN_LAYOUTS`, 14): the six Windows 11 layouts (halves, twoThirds, thirds, mainStack, quad,
  wideCenter 25/50/25) shown by default, plus 70/30, 30/70, one third + two thirds, two quarters + half, 4 columns,
  2 rows, 3 rows, 6 tiles.
- **What the flyouts show:** `snapLayouts` = ordered ids (built-in and custom, ≤ 18; `null` = the six defaults then
  every preset) — the maximize-button flyout, the Win+Z keyboard flyout (numbered: Win+Z, 5, 2 = layout 5, zone 2) and
  the snap bar at the top of the screen when dragging a window (`multitasking.snapBar`).
- **Settings → Snap layouts:** show / hide and reorder every layout, Snap Assist / hover / drag-bar switches, your
  layouts as cards (Edit / Delete), *New layout*: name + kind (Columns, Rows, Main + side, Grid, or Custom: select a
  zone and split it side by side / top and bottom, drag the dividers) with a live numbered preview; *Restore the default
  layouts*; *Show snap layouts* opens the flyout on the Settings window to try them.

### 12.3 Known limitations

- Turning off a shortcut that the main process always captures (any Win combo, Alt+F4, Alt+Space, Ctrl+Shift+Esc…)
  makes it do nothing; the key press is still swallowed and does not reach the app.
- Shortcuts apply to the shell session; the sign-in screen keeps its own keys.

## 13. Feature map and tests

| Request | Where | Checked by |
|---|---|---|
| Theme designer: accent, wallpaper, lock screen, taskbar colour, transparency, blur | §1.1, §2, §9, `personalization-designer.js` | `personalization-core` (`--only=e2e`: real clicks in Settings, 1280×720 FR), `personalization-shell` (checklist) |
| Visual styles: Windows 11-like, minimal, glassmorphism, retro, high contrast | §4 | both |
| Animated and dynamic wallpapers (time of day, weather) | §9 | `wallpapers` (`--only=perf`: per-effect CPU budget, pauses, 20-toggle leak check), `personalization-shell` |
| Taskbar: size, position, icons, widgets, transparency, auto-hide | §10.1 | `taskbar-start-focus` (geometry, taskbar, autohide, fit), `personalization-shell` |
| Start: layout, pinned apps, folders, recommended files, background style | §10.2 | `taskbar-start-focus` (start, folders, labels: whole words on every tile in every style), `personalization-shell` |
| Cursor packs, icon packs, sound packs, notification / startup / shutdown sounds | §11 | `packs-input` (cursors, icons, sounds, profiles, restart), `personalization-shell` |
| Font and text size, rounded corners, UI scale, reduced motion | §1.1 | `personalization-core`, `personalization-shell` |
| Per-app themes (light, dark, system, custom accent) | §3 | both |
| Snap layout presets, customizable keyboard shortcuts | §12 | `packs-input` (snap, shortcuts: rebinding end to end, conflicts, refused combos, persistence), `wm-nav` (snap, snapkeys), `personalization-shell` |
| Focus mode | §10.3 | `taskbar-start-focus` (focus, restart), `personalization-shell` |
| Profiles: save and switch complete UI themes with one click | §5 | both (`personalization-shell` and `personalization-core --only=e2e` round-trip every `PROFILE_KEYS` key; the latter also checks import hardening and that every documented key is saved) |

`shell/test/personalization-shell.test.mjs` drives each item through the Settings UI of the real shell, round-trips a
profile with a non-default value for every key in `PROFILE_KEYS` (save → reset → apply → identical; export → import),
applies each built-in profile × each visual style × each taskbar edge with Start and Quick settings open (no console
errors, flyouts on screen), checks English / French, light / dark at 1280×720 and 1920×1080, and restarts the shell to
check persistence. It writes `test/out/personalization-checklist.json` and the `docs/screenshots/pzs-*.png` pictures
(`--no-shots` skips them).

```sh
cd shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/personalization-shell.test.mjs
```

## 14. Résumé en français

La personnalisation de Selene OS est complète et pilotée par des clés de paramètres (toutes appliquées en direct,
persistées dans `~/.config/aurora/settings.json`, avec une valeur par défaut dans `main/ipc/settings.js`, accessibles
depuis Paramètres › Personnalisation en anglais et en français, et enregistrées par les profils) :

- **Concepteur de thème** : couleur d’accentuation, fond d’écran, écran de verrouillage, couleur de la barre des tâches,
  transparence des fenêtres et intensité du flou (§1.1).
- **Styles visuels** : Windows 11, minimal, verre (glassmorphism), rétro et contraste élevé (§4).
- **Fonds d’écran animés et dynamiques** : six scènes animées (30 i/s max., en pause quand elles sont cachées ou avec
  « réduire les animations »), images qui suivent l’heure du jour et la météo, diaporama, écran de verrouillage (§9).
  La météo du lieu choisi s’affiche aussi dans le panneau Widgets et la barre des tâches.
- **Barre des tâches** : taille (40 / 48 / 56 px), position (bas, haut, gauche, droite), icônes, recherche (icône ou
  zone), noms des applications et regroupement des boutons (« Ne jamais combiner »), badges de notifications, icônes de la
  zone de notification et secondes, position du bouton Widgets, mini-widgets (météo, processeur, mémoire, réseau),
  couleur et transparence, masquage automatique avec délai ; clic droit → Paramètres de la barre des tâches (§10.1).
- **Menu Démarrer** : disposition, applications épinglées, dossiers d’applications à la Windows 11 (glisser une
  application sur une autre, ouvrir, renommer sur place, sortir une application en la faisant glisser, un dossier d’une
  seule application disparaît), recommandations (applications récemment ajoutées, les plus utilisées, fichiers ouverts
  récemment), dossiers à côté du bouton d’alimentation, style d’arrière-plan (acrylique, verre transparent, uni, couleur
  d’accentuation, fond d’écran) ; il suit l’alignement et le bord de la barre (§10.2).
- **Mode concentration** : active « Ne pas déranger » (rétabli ensuite) et masque les badges et le clignotement des
  boutons de la barre des tâches, assombrit le bureau, peut masquer les icônes du bureau, simplifie la barre des tâches
  avec une puce du temps restant ; durée de session (25, 50, 90 min…), bannière,
  notification de fin, survit à un redémarrage ; Win+Maj+F, vignette des paramètres rapides, sessions de l’Horloge
  (§10.3).
- **Packs** : sept packs de curseurs (avec une taille de 100 à 300 %), huit packs d’icônes (dont Verre, Monochrome et
  Pixel rétro, appliqués aussi à Ce PC et à la Corbeille), cinq packs de sons (13 sons chacun), le volume des sons
  système, et un son au choix pour les notifications, le démarrage et l’arrêt (son d’un autre pack, aucun, ou fichier
  audio) (§11).
- **Police et taille du texte, arrondi des coins, échelle de l’interface, mode « réduire les animations »** (§1.1).
- **Thèmes par application** : clair, sombre, système ou accent personnalisé (§3).
- **Dispositions d’ancrage personnalisées** (14 dispositions intégrées à afficher et réordonner, éditeur par découpage
  de zones) et **raccourcis clavier modifiables** (46 actions + « ouvrir cette application » ; enregistrement d’une
  combinaison avec Win, Ctrl + Alt ou F13–F24, conflits résolus, désactivation, restauration) (§12).
- **Profils** : enregistrer l’apparence complète et passer d’un thème à l’autre en un clic ; export / import validé (§5).
- **Thèmes (12 octobre 2026)** : Halo (par défaut), Prisme et Sobre, en haut de Paramètres › Personnalisation sous forme
  de trois grandes cartes avec un aperçu, puis « Personnaliser le thème » (style, ambiance, accent, fond d’écran,
  transparence des fenêtres, flou, « Teinter les fenêtres selon le fond d’écran », jeu d’icônes avec « Automatique (suit
  le thème) »). Réglages rapides › Apparence propose les trois thèmes au-dessus du style. Clés : `finish`,
  `tintFromWallpaper`, `iconPack: 'auto'` (§1.1, §6).

Limites connues : les curseurs ne s’appliquent pas dans les pages web ; les packs d’icônes ne changent pas les icônes
dessinées par les applications elles-mêmes ; un raccourci système désactivé reste intercepté ; l’écran de connexion
utilise les paramètres système ; la météo nécessite un accès réseau (testée avec une simulation).
