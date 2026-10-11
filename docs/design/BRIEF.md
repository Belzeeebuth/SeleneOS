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

## Proposed names (to be validated)

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
