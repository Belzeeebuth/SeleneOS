# Store sources (Flathub, Ubuntu, Selene picks)

The Store shows one catalogue made of three **sources**:

| Source id | What | Install as | Root needed |
|---|---|---|---|
| `selene` | The curated list in `/usr/share/aurora/store/catalog.json`: tools, services and the 12 hand-picked GUI apps. | apt package | yes (aurora-admin `store-install`, UAC prompt) |
| `ubuntu` | Every desktop application of the Ubuntu archive that has AppStream metadata (DEP-11: main, universe, restricted, multiverse; noble, noble-updates, noble-security). | apt package | yes (aurora-admin `store-install`, UAC prompt) |
| `flathub` | The whole Flathub catalogue. | Flatpak, **per-user** (`flatpak --user`) | no |

Snap is not a source: Selene OS has no snapd.

## Source modules (main process)

Each source is a CommonJS module in `shell/main/lib/sources/<id>.js`. `shell/main/ipc/store.js` loads the modules
inside try/catch, so a missing or broken module only hides that source. Each module exports:

```js
module.exports = {
  id: 'flathub',                       // 'ubuntu' | 'flathub'
  label: { en: 'Flathub', fr: 'Flathub' },
  init(ctx),                           // ctx = { api, DEV, env, home, broadcast } (called once by store.js)
  async status(),                      // { available, ready, updatedAt, count, error?, live? }
  async refresh(onProgress),           // download / rebuild the catalogue cache; onProgress({ phase, percent? })
  async search({ query, category, offset, limit }),   // -> { items: [Item], total }
  async details(id),                   // -> Item, plus description, screenshots, homepage, license, developer
  async installed(),                   // -> [ { id, version?, size? } ]
  async install(id, onProgress),       // onProgress({ percent?, message? }); resolves { desktopId? }
  async remove(id, onProgress),
};
```

The `ubuntu` module installs and removes through the existing admin path, using the same
`api`/`admin.js` mechanism as `store.js` today.

### Item

```js
{
  source: 'flathub' | 'ubuntu' | 'selene',
  id: 'org.gimp.GIMP',              // flathub: app id; ubuntu: apt package name; selene: catalog id
  appId: 'org.gimp.GIMP',           // AppStream component id without a ".desktop" suffix (merge key), or null
  name: 'GNU Image Manipulation Program',
  summary: '…',                     // localised: French when the shell language is fr and the data has it
  icon: 'media://local/…png' | 'https://…' | null,
  categories: ['Graphics', …],      // freedesktop main categories (AudioVideo, Development, Education, Game,
                                    // Graphics, Network, Office, Science, Settings, System, Utility)
  installed: false,
  desktopId: 'org.gimp.GIMP.desktop' | null,   // used by "Open" to launch through the registry (linux.<id>)
  // details() adds: description (plain text, paragraphs separated by \n\n), screenshots: [url], homepage,
  // license, developer, version, downloadSize?
}
```

### Development and tests

- When `DEV` is set and `AURORA_REAL_BACKENDS` is not `1`, every module serves a deterministic fixture
  catalogue: about 20 apps with small PNG icons, in `shell/test/fixtures/store-<id>/`.
- Install and remove are simulated with progress events, and nothing touches the network or the system.
- `AURORA_STORE_DEV_FAIL=<id>` makes install fail.

## Flathub (`flathub.js`)

- **Remote.** Added per user on first use with
  `flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo`, without
  root.
- **Catalogue.** `flatpak update --user --appstream flathub`, then the user's
  `appstream/flathub/x86_64/active/appstream.xml.gz` and its `icons/128x128` and `icons/64x64` are parsed into a
  JSON cache under `~/.cache/aurora/store/`. The XML is parsed by a python3 stdlib helper (`iterparse`), so
  memory stays flat.
- **Install and remove.** `flatpak install --user -y --noninteractive flathub <id>` and
  `flatpak uninstall --user -y --noninteractive <id>`, streaming progress. The list of installed apps comes from
  `flatpak list --user --app --columns=application,version,size`.
- **Desktop files.** Exported desktop files land in `~/.local/share/flatpak/exports/share/applications`, which
  `xapps.js` already scans. Their `Exec` uses the flatpak `@@u %U @@` / `@@ %F @@` markers, which `xapps.js`
  must handle.
- **Theme.** Flatpak apps follow the light or dark theme through xdg-desktop-portal-gtk:
  `gsettings set org.gnome.desktop.interface color-scheme prefer-dark|default`, also set by `xapps.js`.

## Ubuntu (`ubuntu.js`)

- **Catalogue.** It is downloaded as the user, with no root:
  - `dists/<suite>/<component>/dep11/Components-amd64.yml.gz` and `icons-64x64.tar.gz`, for each suite and
    component listed in `/etc/apt/sources.list.d/ubuntu.sources` (deb822, falling back to `/etc/apt/sources.list`);
  - over HTTP(S), from the configured mirror;
  - into `~/.cache/aurora/store/ubuntu/`;
  - parsed by a python3 helper using python3-yaml, that keeps only `Type: desktop-application`;
  - with the icons extracted to the cache.
- **Install.** aurora-admin `store-install` also accepts a package that is not in `catalog.json` when, after
  `apt-get update`, it appears as `Package: <name>` in a root-owned DEP-11 Components file under
  `/var/lib/apt/lists/`. The ISO ships `appstream`, so apt downloads those files.
- **Remove.** It keeps the existing safety rule: it never removes other packages, and Selene's fixed packages are
  never removed.

## Store app

Three views draw on the merged catalogue: Home (featured and per-category rows), Search and Categories.
- Items with the same `appId` are merged into one card. The card shows its sources as badges, and Details
  offers a source picker.
- The default source is `selene`, then `ubuntu`, then `flathub`, but Flathub is the only one for apps that
  exist only there (Firefox, Spotify, Discord…).
- Lists are paginated or virtualised: there are thousands of apps.
- The Installed and Updates pages cover all sources.
- In the live session, a note says that installed apps are kept in memory and lost at restart. This matters
  most for Flatpak runtimes, which are large.
