# Selene design system: the token contract

This is the contract between the foundations (phase A) and the components (phase B: bar, Lanceur, panels,
windows, every app). It covers four things:

- what each token means;
- which hooks each style sets;
- how to style a component once for the three styles;
- the rules that keep Selene accessible and fast.

The decisions behind it are in [BRIEF.md](BRIEF.md). The settings keys are in
[../PERSONALIZATION.md](../PERSONALIZATION.md).

| File | Role |
|---|---|
| `shell/renderer/core/tokens.css` | The fonts (`@font-face`), the global tokens, the three ambiances × two modes, and the semantic colour tokens |
| `shell/renderer/core/styles/nocturne.css`, `eclipse.css`, `clairdelune.css` | Shape tokens and structural hooks of each style. No component rules. |
| `shell/renderer/core/styles/contrast.css` | High contrast (accessibility): its own palette, thick borders and component overrides |
| `shell/renderer/core/styles/base.css` | Effects shared by every style (blur intensity, reduced motion) |
| `shell/renderer/core/theme.js` | Sets the attributes on `<html>`, the accent values (inline), and the computed variables |
| `shell/renderer/assets/fonts/` | Inter and Manrope variable woff2 files (latin + latin-ext), OFL licences |

## 1. Attributes on `<html>`

theme.js sets them. Components never set them; they only read the tokens.

| Attribute | Values | Source |
|---|---|---|
| `data-style` | `nocturne` (default), `eclipse`, `clairdelune`, `contrast` | `settings.style` |
| `data-ambiance` | `cold`, `neutral`, `warm` | `settings.ambiance` (follows the style unless the user picks one) |
| `data-accent` | `silver`, `night`, `violet`, `amber`, `custom` | `settings.accent` (a hex; the four presets are recognised) |
| `data-theme` | `dark` (default), `light` | `settings.theme` |
| `data-transparency` | `on`, `off` | `off` with High contrast or when the user turns transparency off |
| `data-animations`, `data-reduced-motion` | `on`, `off` | Reduced motion implies `data-animations="off"` |

The sign-in screen (`greeter.html`) gets the same attributes through `applyVisualStyle()`.

**Scopes.** An element with `data-theme-scope data-theme="dark|light"` gets every colour token of that mode.
This covers a per-app themed window, a custom-coloured bar and the previews in Settings. An element with
`data-ambiance` re-colours its subtree in that ambiance. An element with `data-style` gets that style's shape
tokens.

## 2. Tokens

### 2.1 Fonts and text

| Token | Value |
|---|---|
| `--font` | Inter, then Noto Sans and DejaVu Sans. Use it for all running text. |
| `--font-display` | Manrope, then Inter. Use it for titles, the clock, and the names in the Lanceur. |
| `--font-mono` | Cascadia Code / DejaVu Sans Mono (unchanged) |
| `--fs-caption` 12, `--fs-small` 13, `--fs-body` 14, `--fs-body-large` 17, `--fs-subtitle` 20, `--fs-title` 26, `--fs-title-large` 36, `--fs-display` 64 px | Each follows `--text-scale`. Line heights use `--lh-*`. |

Text that people read is 13 px at least (`--fs-small`). `--fs-caption` (12 px) is only for short labels
under icons. Use tabular numbers (`font-variant-numeric: tabular-nums`) for the clock, dates and sizes.

### 2.2 Colour: surfaces, text and lines

Every colour comes from the ambiance and the mode. **Never write a hex value in a component.** Use these
tokens:

| Token | Meaning |
|---|---|
| `--desk` | Behind everything (desktop colour when no wallpaper) |
| `--bg` = `--surface` | Window and content surface (opaque) |
| `--bg-alt` = `--surface-sunken` | Sidebars, the navigation pane, wells |
| `--surface-raised`, `--card-solid`, `--control`, `--input-bg` | Fields, buttons, raised cards (opaque) |
| `--titlebar-bg` | Title band of a window. It is the surface tone in Nocturne (cold), and one tone off in the neutral and warm ambiances. |
| `--card`, `--layer`, `--layer-alt` | Light overlays that work on any surface |
| `--subtle-hover`, `--subtle-pressed`, `--subtle-selected` (= `--sel-bg`) | Hover, press and selection overlays of rows and icon buttons |
| `--text`, `--text-2`, `--text-3` | Primary, secondary and tertiary text. Each one is ≥ 4.5:1 on `--bg`, `--bg-alt` and `--surface-raised`, in every ambiance and mode. |
| `--text-disabled` | Disabled text only (exempt from contrast) |
| `--line` (= `--stroke-strong`, `--window-stroke`, `--control-stroke`) | Hairlines: window border, field border |
| `--line-soft` (= `--stroke`, `--stroke-card`) | Separators inside a window |
| `--glass`, `--glass-strong`, `--glass-line`, `--glass-fill` | The blurred surfaces (bar, Lanceur, panels). They are 80–92 % opaque. |
| `--acrylic`, `--acrylic-strong`, `--taskbar-bg` | Older names of the same glass (kept for the existing code) |
| `--shadow-window`, `--shadow-window-inactive`, `--shadow-flyout` (= `--shadow-float`), `--shadow-dialog`, `--shadow-tooltip` | Shadows, tinted with the ambiance |
| `--danger`, `--success`, `--warning` (+ `-bg`), `--on-danger`, `--close-hover` | Status colours |
| `--tint`, `--glass-rgb`, `--bar-rgb`, `--shadow-rgb` | rgb triplets (`205 216 238`), for `rgb(var(--tint) / 0.07)` |

The `--mica-tint*` tokens are now opaque (equal to `--bg` and `--bg-alt`). Windows have no Mica any more.

**The palettes.** These are the raw values, set in `tokens.css` as `--amb-d-*` (dark) and `--amb-l-*` (light).
Components never read them directly.

| Ambiance | Dark: surface / sunken / raised / text / text-2 / text-3 | Light: surface / sunken / text / text-2 / text-3 |
|---|---|---|
| cold (Nocturne) | #121826 / #0E131F / #1A2133 / #E6EAF2 / #A9B2C5 / #959FB4 | #FBFCFE / #F1F4F9 / #141A26 / #475165 / #5A6478 |
| neutral (Éclipse) | #18181B / #131315 / #222226 / #EDEDEF / #A9A9B2 / #A0A0A9 | #FFFFFF / #F4F4F5 / #141416 / #55555E / #63636C |
| warm (Clair de lune) | #1F1A16 / #1B1613 / #2A231E / #F3EADF / #C4B7A7 / #B0A292 | #FFFCF8 / #F1E9DD / #2A211B / #5A4D42 / #6B5D51 |

The lowest ratio is tertiary text, which is 5.8:1 or more on the plain surfaces and 4.7:1 or more on a selected row (`--sel-bg` over `--surface-raised`). On the glass at its default alpha (0.92), `--text-3` and `--accent-text` stay ≥ 4.5:1 even over a black or white wallpaper; at the 0.80 floor (maximum transparency, chosen by the user) only `--text` is guaranteed over such extremes.

### 2.3 Accent

`settings.accent` stays a `'#rrggbb'` value. theme.js recognises the four presets
(`ACCENT_PRESETS`) and writes curated values for each mode. Any other hex is a custom colour, and its shades
are computed.

| Preset | Stored hex | Dark: `--accent` / `--on-accent` | Light: `--accent` / `--on-accent` |
|---|---|---|---|
| `silver` (Argent lunaire) | #c9d3e6 | #c9d3e6 / #101624 (12:1) | #55637e / #fff (6:1) |
| `night` (Bleu nuit) | #6f8de6 | #8ba3ec / #0b1020 (7.7:1) | #3756b8 / #fff (6.6:1) |
| `violet` | #a58bf2 | #b9a4f2 / #160f2b (8.5:1) | #6a4bc3 / #fff (6.2:1) |
| `amber` (Ambre) | #e9b566 | #f2a63a / #1a1206 (9:1) | #a65a06 / #fff (5.1:1) |

| Token | Use |
|---|---|
| `--accent` | Fills: the primary button, a toggle that is on, the selected tab underline, the selection bar (`--sel-bar`) |
| `--on-accent` | Text and icons on an `--accent` fill |
| `--accent-text` | Accent-coloured text and links on a surface. It is ≥ 4.8:1 on every surface. |
| `--accent-hover` (= `--accent-strong`), `--accent-pressed` | States of an accent fill |
| `--accent-subtle` (= `--accent-soft`) | Tinted background, such as the active app in the bar or the selected item in the Lanceur |
| `--accent-base` | The stored hex (for canvases or icons that need the raw colour) |

The accent marks things: selection, focus, the active app, a primary action. It never fills large areas.

### 2.4 Shape, spacing, motion

| Token | Value |
|---|---|
| `--radius-xs` / `--radius-sm` / `--radius` / `--radius-lg` | 4 / 6 / 8 / 10 px in Nocturne, with 8 px windows in Éclipse and Clair de lune. Use `--radius-sm` for controls, `--radius` for cards and menus, and `--win-radius` for windows. Each one × `--corner` (the user's setting). |
| `--radius-float` (= `--float-radius`) | The Lanceur and the panels: 16 px (Nocturne), 12 px (Éclipse), 20 px (Clair de lune) |
| `--sp-1` … `--sp-12` | 4, 8, 12, 16, 20, 24, 32, 48 px |
| `--dur-fast` 120 ms, `--dur` 150 ms, `--dur-slow` 180 ms, `--dur-slower` 240 ms | Durations. They become 0 with reduced motion. |
| `--ease` (ease-out), `--ease-in`, `--ease-std` | Easing. `--ease-spring` has no overshoot any more. |
| `--blur`, `--blur-sm/-md/-lg` | Backdrop blur, 28 px by default, for the allowed surfaces only (§5) |
| `--a-acrylic`, `--a-fly`, `--a-tb` | Alpha of the glass: 0.92 at the default transparency, never below 0.80 (the taskbar opacity setting is clamped too), 1 with transparency off. |

## 3. Structural hooks (one set per style)

Each style file sets plain values. Components read them; they never test `data-style` in their own CSS
(High contrast excepted).

| Hook | Nocturne | Éclipse | Clair de lune | Meaning |
|---|---|---|---|---|
| `--bar-mode` | `islands` | `full` | `pills` | Layout of the bar (see below) |
| `--bar-apps-align` | `center` | `center` | `center` | App icons are centred in **every** style |
| `--bar-h` | 48px | 48px | 48px | Bar height (the size setting still applies) |
| `--bar-margin` | 12px | 0px | 12px | Gap between the bar and the screen edges |
| `--bar-radius` | 16px | 0px | 24px | Corner radius of an island or pill |
| `--bar-gap` | 8px | 0px | 12px | Gap between islands or pills |
| `--bar-border` | 1px glass line | 1px line on the top edge | 1px glass line | Border of the bar's parts |
| `--bar-indicator` | `dot` | `top-line` | `dot` | Marker of a running app; the active app also gets `--accent-subtle` |
| `--bar-blur` | 1 | 0 | 1 | 0 = the bar is opaque (`rgb(var(--bar-rgb))`) and never blurs |
| `--win-border` (`--win-border-w`) | 1px `--line` | 0 | 0 | Window border |
| `--win-shadow`, `--win-shadow-inactive` | standard | soft, shorter | large, soft | Window shadow (use them as they are) |
| `--win-radius` | 10px | 8px | 8px | Window corners |
| `--sel-mode` (`--sel-bar-w`) | `fill` (0) | `bar` (3px) | `fill` (0) | Selected list rows: an overlay (`--sel-bg`), plus in Éclipse a `--sel-bar-w` bar of `--sel-bar` on the left edge |
| `--panel-grain` | `none` | `none` | SVG noise `url()` | Extra `background-image` layer on the blurred panels |

**Bar modes.** The Lanceur and its search are on the left, the apps in the centre, and the status and clock on
the right.

- `islands`: two floating islands. The left one spans from the left edge to the status island and holds the
  Lanceur, the search and the apps, centred on the screen. The right one holds the status and the clock.
- `full`: one opaque bar, docked to the edge, full width.
- `pills`: three separate pills sized to their content: left, centre (apps) and right.

**Reading a keyword hook in CSS.** Use a container style query. Every element is a style container, so the query
reads the value inherited from `<html>`.

```css
.tb-part { background: var(--glass); border: var(--bar-border); border-radius: var(--bar-radius); }
@container style(--bar-mode: full) {
  #taskbar { inset: auto 0 0 0; background: rgb(var(--bar-rgb)); border-top: var(--bar-border); }
  .tb-part { background: none; border: 0; border-radius: 0; }
}
@container style(--bar-mode: pills) { .tb-apps { width: max-content; } }
```

In JavaScript, read `getComputedStyle(document.documentElement).getPropertyValue('--bar-mode').trim()`, and
listen to `theme.on('style', fn)`.

## 4. Styling a component for every style

1. Use only tokens for colour, radius, shadow and duration. The ambiance, accent and mode then come for free.
2. Use the hooks of §3 for anything whose shape differs between styles. If a new difference is needed, add a
   hook to all three style files and to this table. Do not write `[data-style="eclipse"] .x`.
3. Write High contrast rules in `styles/contrast.css` only when the tokens are not enough, for example for
   thicker borders.
4. Check the component in the Settings previews: `stylePreview(pc, styleId, { choose: true })` in
   `apps/settings/pages/personalization-designer.js` draws it with the real classes.
5. Keyboard focus is `outline: 2px solid var(--focus-ring)` with a 2 px offset, on every interactive
   element. In Éclipse a selected row also gets its accent bar, but focus stays the outline.

**Example: a list row.**

```css
.row { border-radius: var(--radius-sm); transition: background var(--dur-fast) var(--ease); }
.row:hover { background: var(--subtle-hover); }
.row.selected { background: var(--sel-bg); box-shadow: inset var(--sel-bar-w) 0 0 var(--sel-bar); }
.row:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
```

**Example: a window.**

```css
.win { background: var(--bg); border: var(--win-border); border-radius: var(--win-radius); box-shadow: var(--win-shadow); }
.win:not(.active) { box-shadow: var(--win-shadow-inactive); }
.win-titlebar { background: var(--titlebar-bg); height: var(--titlebar-h); }
```

## 5. Do and don't

- **Blur only on the bar, the Lanceur and the panels** (quick settings, notifications, calendar). The bar
  blurs only when `--bar-blur` is 1. Use `backdrop-filter: blur(var(--blur)) saturate(var(--blur-sat))` on
  a `--glass` background. That background is 80–92 % opaque, so the surface stays readable when blur
  silently fails (software rendering, a VM without 3D).
- **No Mica or acrylic look anywhere else.** Windows, dialogs, menus and app content are flat and opaque
  (`--bg`, `--bg-alt`, `--surface-raised`). Do not use `var(--mica-image)`. It is `none` in the new styles.
- **Icons: Phosphor only** (regular; fill for active states). No Fluent glyphs, no emoji in the interface.
- **Fonts: Inter and Manrope only.** Do not use Segoe, and do not use a font stack of your own. Use
  `--font` and `--font-display`.
- **Contrast:** text ≥ 4.5:1 and UI parts ≥ 3:1, checked with the real hex values. Do not put `--accent` text
  on `--accent-subtle` in light mode without checking it; use `--accent-text`.
- **Motion:** 120–180 ms, ease-out, opacity and transform only. Nothing bounces, and nothing moves when
  `data-animations="off"`.
- **No hex values in components** (logos and app icons excepted). No Windows names in new text. The validated
  names are in BRIEF.md.
- **Copy:** French uses "vous". Write short sentences that say what happens, with no slogans and no emoji.

## 6. JavaScript API (`core/theme.js`)

| Export | Use |
|---|---|
| `STYLES` | `[{ id, name, desc, defaults: { ambiance, accent, wallpaper } \| null, traits }]` |
| `AMBIANCES` | `[{ id, name, desc, swatch: { dark, light } }]` |
| `ACCENT_PRESETS`, `ACCENTS`, `DEFAULT_ACCENT`, `accentPreset(hex)` | The four accents |
| `styleChoicePatch(id, all)` | The settings patch for choosing a style: the ambiance, accent and wallpaper follow the style unless the user changed them |
| `chooseStyle(id)` | Applies that patch (one `settings:setMany`). Use it from quick settings. |
| `ambianceOf(all)`, `styleDefaults(id)`, `LEGACY_STYLES` | Helpers |
| `theme.style`, `theme.ambiance`, `theme.mode`, `theme.on('style' \| 'change', fn)` | Current state |

A plain `settings.set('style', id)` gets the same follow rule: theme.js sends the rest of the patch.

## 7. Résumé en français

Ce document est le contrat de la phase B. Les composants n'utilisent que des jetons : les couleurs (`--bg`,
`--text`, `--accent`…), les rayons, les ombres et les durées. Chaque style (Nocturne, Éclipse, Clair de lune)
ne définit que des crochets de forme : `--bar-mode`, `--bar-margin`, `--win-border`, `--sel-bar-w`,
`--panel-grain`… On les lit avec `@container style(--bar-mode: full)`. L'ambiance (froide, neutre, chaude) et
l'accent (argent lunaire, bleu nuit, violet, ambre) sont indépendants du style. Le flou est réservé à la barre,
au Lanceur et aux panneaux, avec un fond opaque à 80–92 %. Il n'y a pas de Mica, les icônes viennent de
Phosphor et les polices sont Inter et Manrope. Tous les textes atteignent un contraste d'au moins 4,5:1.

## 8. UI icons (Phosphor)

The shell's UI icons are Phosphor 2.1.1 (MIT), packed in `shell/renderer/assets/icons/phosphor.json` (regular,
fill and bold weights of the glyphs in use; licence in `LICENSE-phosphor.txt`). `fluent.json` is no longer
loaded; it stays in the tree only until `solitaire.test.mjs`, `wallpapers.test.mjs` and `store.test.mjs` stop
reading it.

| Export (`core/icons.js`, re-exported by `core/ui.js`) | Use |
|---|---|
| `loadIcons()` | Loads `phosphor.json` once at startup |
| `icon(name, { size, filled, weight, class, color })` | A `<span class="icon">` with the SVG inside |
| `iconSvg(name, opts)`, `iconInner(name, opts) -> { vb, inner }` | The SVG markup, or its paths and viewBox size |
| `hasIcon(name)`, `resolveIcon(name) -> { glyph, weight } \| null` | Checks and resolves a name |

- **Names.** New code uses Phosphor kebab-case names: `icon('gear-six')`. A weight can be a suffix
  (`'caret-down-bold'`, `'star-fill'`) or `opts.weight` (`'regular' | 'fill' | 'bold'`). Old Fluent names
  (`'folder'`, `'settings'`, `'folder_filled'`) keep working through `assets/icons/aliases.json`
  (hand-edited, value `'glyph'` or `'glyph:fill'`); saved settings that hold a Fluent name need no migration.
- **Weights.** Regular by default; `filled: true` for active and selected states; `size <= 12` switches to
  bold so thin strokes stay visible.
- **Format.** Every SVG is `viewBox="0 0 256 256" fill="currentColor"` with fill-based paths: the colour comes
  from CSS `color`, never from `stroke`. Code that extracts the paths must read the viewBox (see Paint's
  `glyphCursor`).
- **Unknown names** draw a dashed circle (`circle-dashed`) and warn once in the console.
- **Adding a glyph.** From `shell/`, run `node tools/vendor-icons.mjs <phosphor>/assets` (or set
  `PHOSPHOR_ASSETS`). It packs every name used at `icon('…')`, `iconSvg('…')` and `icon: '…'` call sites, plus
  the `EXTRA` list in the script; add names built at run time to `EXTRA` / `DYNAMIC`. Then run
  `test/icons.test.mjs`.
- **Main alias choices.** `folder -> folder-simple`, `settings -> gear-six`, `apps -> circles-four`,
  `app_generic -> app-window`, `window_console -> terminal-window`, `arrow_download -> download-simple`,
  `wifi_1` (strongest in Fluent) `-> wifi-high`. Never use `squares-four` or `windows-logo` for apps or the
  Lanceur.
- **Left for phase B.** The tray's hand-drawn `wifiSvg`, `ETHERNET_SVG` and `batterySvg` in `core/taskbar.js`
  and the window controls in `core/wm.js` are not icon-set glyphs yet (the window-control glyphs `x`, `minus`,
  `square`, `copy-simple` are already packed). Switch the three tests above to `phosphor.json`, then delete
  `fluent.json` (2.5 MB).

En bref : les icônes de l'interface viennent de Phosphor (poids regular, fill pour les états actifs). Les
anciens noms Fluent restent valides grâce à `aliases.json`, mais le nouveau code utilise les noms Phosphor.
