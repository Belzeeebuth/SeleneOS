# Selene OS: visual redesign brief

The current look is close to Windows 11:
- Fluent icons;
- Segoe and Inter;
- Mica and acrylic effects;
- the "bloom" wallpaper;
- names such as "Ce PC" and "Explorateur de fichiers".

The redesign gives Selene its own identity.

## User answers (2026-10-11)

| Topic | Decision |
|---|---|
| Direction | Selene's own identity, copying neither Windows, macOS nor GNOME. |
| Theme | The moon as the common thread: night, silver, soft light. |
| Bar | Stays at the bottom, redesigned. |
| Launcher | Same structure as the current Start menu (search, pinned apps, recommended, user and power), with a new look. |
| Window buttons | On the right. |
| Transparency and blur | A mix: blur on a few surfaces (bar, launcher, panels), flat colour elsewhere (windows, content). |
| Corners | Slightly rounded. |
| Default mode | Dark. |
| Accent | Four accents to choose from in the theme menu: lunar silver, night blue, violet, warm amber. |
| Colour mood | Several moods to choose from in the theme menu: cold (blues, slate), neutral (pure greys), warm (warm blacks, cream). |
| Font | Inter or Manrope, our choice. Accessibility comes first. |
| UI icons | Phosphor (MIT), replacing Fluent. |
| App icons | All 37 redrawn in one style: rounded square. |
| Wallpapers | A mix of night and moon scenes and lunar abstracts. The current set is replaced. |
| Animations | Discreet and fast. |
| Logo | The crescent is reworked: same idea, more refined. |
| French copy | Formal "vous". Simple and warm, with no slogans and no ready-made AI turns of phrase. |
| Names | The Windows-flavoured names are renamed. The list is validated by the user (below). |
| Scope | Everything: shell, every app, boot (GRUB, Plymouth) and the installer. |
| Visual styles | The list is reviewed entirely around Selene. |
| Keyboard shortcuts | Kept (Super+E, Alt+Tab, Super+arrows…). |
| Method | 2 or 3 mockups first; the user picks, then we implement. |
| Priorities | Accessibility (contrast, sizes, keyboard) and performance (smooth in a VM without 3D). |

## Copy rules

- Short sentences that say what happens: « Le fichier a été copié », « Impossible de se connecter au réseau ».
- No slogans or punchy fragments ("Nouveau. Plus rapide. Plus vous."). No needless exclamation marks, and no
  emojis in the interface.
- "Vous" everywhere. Buttons are verbs in the infinitive (« Enregistrer », « Installer »).
- Warm means polite and calm, not familiar.

## Names (validated by the user on 2026-10-11)

| Today | Proposed |
|---|---|
| Démarrer (button and menu) | Lanceur |
| Ce PC | Ordinateur |
| Explorateur de fichiers | Fichiers |
| Outil Capture | Capture d'écran |
| Gestionnaire des tâches | Moniteur système |
| Bloc-notes | Éditeur de texte |
| Paint | Dessin |
| Pense-bêtes | Mémos |
| To Do | Tâches |
| Lecteur multimédia | Lecteur |
| Store | Logithèque |
| Selene Browser | Navigateur |
| Gestionnaire d'archives | Archives |
| Vue des tâches | Vue d'ensemble |
| Dispositions d'ancrage (Snap layouts) | Dispositions |
| Widgets | Tableau de bord |
| Paramètres rapides | Réglages rapides |
| Menu Win+X | Menu rapide |
| Contrôle de compte d'utilisateur | Autorisation administrateur |
| À propos de Windows (winver) | À propos de Selene |
| Mode concentration | Concentration |
| Unchanged | Corbeille, Paramètres, Courrier, Calculatrice, Photos, Horloge, Calendrier, Notes, Terminal, Lecteur PDF, Météo, Cartes, Contacts, Traducteur, Bureau à distance, Disques, Sauvegarde, Mots de passe, Cloud, Outils réseau, the games |

## Assets

- **Fonts:** `docs/design/mockups/assets/fonts/` holds Manrope and Inter as variable woff2 files (OFL).
- **Icons:** Phosphor 2.1.1 (MIT), with the regular, light, bold, fill, duotone and thin weights. They are in the build machine's scratchpad, and the redesign will vendor them into the shell.

## Decisions after the mockups (2026-10-11)

### Styles

The three mockups (`docs/design/mockups/{nocturne,eclipse,clairdelune}`) all become styles that the user picks in
Paramètres > Personnalisation. The new list replaces the old one (Windows 11, Minimal, Glass, Retro):

| Style | Default ambiance | Default accent | Bar |
|---|---|---|---|
| Nocturne (default) | cold | silver | Floating islands. |
| Éclipse | neutral | amber | Full width, opaque. |
| Clair de lune | warm | violet | Three floating pills. |
| Contraste élevé | (its own) | (its own) | Kept for accessibility. |

- The ambiance (cold, neutral, warm) and the accent (silver, night blue, violet, amber) can be chosen
  independently of the style. Each style only sets their defaults.
- In every style, **the bar's app icons are centred**. This is the user's choice. The Lanceur and its search
  stay on the left, and status and the clock on the right.

### Other decisions

| Item | Decision |
|---|---|
| App icons | Rounded square on a **common night-blue base**, with a symbol in **muted** colours, so not saturated iOS-style gradients. It applies to all 37 apps plus the default icon for Linux apps, and replaces the old Fluent icon pack. Update (2026-10-12, user request): the base and the symbols follow the ambiance, so no blue shows outside the cold ambiance (warm charcoal for Éclipse, plum for Clair de lune; `shell/renderer/core/app-icon-art.js`). |
| Logo | Crescent plus a **small round dot-star**. The four-point sparkle is dropped. |
| Names | The table above is validated as is. |
| Font | Manrope for titles, Inter for text (variable woff2 vendored in the shell; OFL). |
| UI icons | Phosphor (regular weight; fill for active states), replacing Fluent everywhere. |
| Glass | Blurred surfaces (bar, Lanceur, panels) stay 80–92 % opaque, because blur silently fails in software rendering. |

## Decision (2026-10-12): two themes from the mixed mockups, Halo by default

The user found the flat Selene look "not very pretty" and wanted back the richness of the earlier version: colourful
app icons, translucent glass windows tinted by the wallpaper, vivid wallpapers, together with Selene's three styles
and ambiances. Two mixed mockups were made (`docs/design/mockups-mix/halo`, `docs/design/mockups-mix/prisme`). The
user keeps **both**, as themes to choose and adjust in Paramètres > Personnalisation:

| Theme (`finish`) | Look | Default |
|---|---|---|
| Halo | Mica-like glass tinted by the wallpaper, colourful free-shape gradient icons, petal-halo wallpapers | **Yes**, for new users and for settings that never chose a theme |
| Prisme | Frosted glass with a faint grain, glossy rounded-square icons (two-tone gradient, white symbol), aurora veils with a small moon | |
| Sobre | The flat Selene look of 2026-10-11, unchanged | |

- The theme sits above the style: each theme works with Nocturne, Éclipse, Clair de lune and Contraste élevé, and
  brings its accent, wallpaper and icon set for each style. Contraste élevé keeps its own colours and solid surfaces
  in every theme.
- Everything stays adjustable under « Personnaliser le thème »: style, ambiance, accent, wallpaper, window
  transparency, blur, « Teinter les fenêtres selon le fond d'écran », and the icon set (« Automatique » follows the
  theme).
- Réglages rapides > Apparence gets the three themes as a compact choice above Style.
- The rules of 2026-10-11 still apply: text ≥ 4.5:1 on the glass in every theme × style × mode, solid surfaces with
  transparency off, reduced transparency or high contrast, live blur only on the bar, the Lanceur, menus and panels
  (windows show a pre-blurred copy of the wallpaper), reduced motion respected. This replaces the line « No Mica or
  acrylic look anywhere else » for the Halo and Prisme themes only.
