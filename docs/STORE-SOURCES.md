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
  async cancel(id),                    // optional: stop a running install -> { canceled }; install() then rejects ECANCELED
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
- **Details of the implementation** (added by the flathub track):
  - Helper: `/usr/lib/aurora/helpers/aurora-catalog-flathub --xml <appstream.xml[.gz]> [--icons DIR] --out FILE|-`
    writes `~/.cache/aurora/store/flathub.json`. It takes about 1 s for 4,400 components. When flatpak's AppStream
    file is newer than the cache, the next read rebuilds the cache, with no network.
  - `status()` also returns `errorCode` (`ENET` | `ENOSPC` | `EFLATPAK`) next to `error` (a localised message), and
    `simulated: true` in dev. `search()` accepts an optional `lang`. `details()` adds `installedVersion`.
  - Error codes: `EINVAL` (bad id), `ENOENT` (not in the catalogue), `EBUSY` (an operation is already running for
    this app), `ENET`, `ENOSPC`, `EFLATPAK` (flatpak is missing or failed, or remote-add failed).
  - Dev: `AURORA_STORE_DEV_FAIL=<id>[:ENET|ENOSPC|EFLATPAK][,…]`, `AURORA_STORE_DEV_DELAY=<ms>` (the delay between
    simulated progress steps, 40 by default). Tests: `AURORA_FLATPAK=<path>` replaces the flatpak binary with a stub.
  - **Cancel** (« Annuler » on the app page while a Flathub install runs; `store:cancel (source, id)`, and
    `store:current ()` so a window opened meanwhile shows the running operation): `cancel(id)` sends SIGTERM to the
    flatpak process group (it runs `detached`, so bwrap triggers stop too), then SIGKILL after 5 s
    (`AURORA_FLATPAK_KILL_MS`). flatpak deploys each ref atomically, so nothing is half-installed; the refs that
    appeared since the install started (`flatpak list --user --all --app|--runtime --columns=ref[,runtime]` before and
    after) are then uninstalled one by one — the app, then runtimes / extensions that no remaining app uses — and
    `install()` rejects with `ECANCELED`. Partial downloads stay in OSTree's staging area (the next try resumes from
    them; OSTree prunes them). A cancel that arrives after flatpak has already succeeded leaves the app installed.
    Removals and apt (UAC) installs cannot be cancelled. Dev: the simulation stops at its next step.
  - xapps.js drops an empty `@@u @@` / `@@ @@` pair from the argv when no file is given. When a missing applications
    directory appears, xapps.js sees it, because it watches the nearest existing ancestor, up to 4 levels up.

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
- **Details of the implementation** (added by the ubuntu track):
  - Helper: `/usr/lib/aurora/helpers/aurora-catalog-apt build --out DIR --source COMPONENTS.yml.gz ICONS.tar.gz …`
    (sources oldest suite first: release, -backports, -security, -updates; a later suite replaces the entry of the
    same package). It writes `DIR/catalog.json` and `DIR/icons/*.png` (only the referenced 64×64 icons). It prints
    `progress <parse|icons|write> <percent>` lines, so `refresh()` reports the phases `download`, `parse`, `icons`,
    `write` and `done`. With libyaml (`CSafeLoader`, as in the ISO) the parse is fast. The pure-python fallback takes
    about 25 s for noble main + universe (1,928 apps). The helper runs at nice 10.
  - Install and remove: `ubuntu` is an admin source, like `selene`. The renderer runs
    `shell.runAdmin('store-install' | 'store-remove', [item.id])`, and `ubuntu.adminAction(op, id)` returns that
    `{ action, args }`. Outside dev, the module's `install()`/`remove()` reject with code `EADMIN` and
    `err.admin = { action, args }`, because only the renderer can show the UAC prompt. In dev, they run the admin.js
    simulation (`dev.storeRun`), and admin.js accepts the fixture's packages.
  - `status()` also returns `refreshing` and `phase` while a refresh runs. `search()` and `details()` accept an
    optional `lang` ('en' | 'fr'). Without it, the module uses the shell setting, then `env.lang`, then `$LANG`.
  - Outside dev, `status().ready` is false until the first `refresh()`, and store.js decides when to call it. In dev,
    the fixture catalogue is built on first use, and `details().screenshots` points to two local stand-ins
    (`shell/test/fixtures/store-ubuntu/screenshot-{1,2}.png`), so the dev UI never fetches the archive's images.

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

### Aggregator (`shell/main/ipc/store.js`)

The channels are documented in the header of `store.js`: `store:sources`, `store:setEnabled` (Flathub on/off,
saved in `~/.config/aurora/store-sources.json`), `store:refresh` (+`store:progress` `{ kind: 'refresh' }`),
`store:home`, `store:search` (pages of at most 60), `store:details`, `store:install` / `store:remove`
(+`store:progress`), `store:installedAll`, `store:invalidate` and the `store:changed` broadcast. The older
`store:catalog` and `store:installed` channels still work.
- **Merge key.** The key is the `appId` in lower case. The aggregator keeps `appId` exactly as the module gives
  it and never strips `.desktop` itself, because `org.telegram.desktop` is a real id. Curated GUI apps get their
  AppStream id from `catalog.json` (optional `appId` field), then from a small table in `store.js`
  (`gimp` → `org.gimp.GIMP`…), then from their `.desktop` file name.
- **Admin sources.** For `selene` and `ubuntu`, the Store app installs through the renderer's UAC prompt with
  `shell.runAdmin('store-install' | 'store-remove', [package])`, then calls `store:invalidate`.
  `store:install` refuses these sources with `EADMIN`. Only `flathub` installs through `store:install`.
- **Errors.** The app shows `ENET` / `ENETWORK` as "no network", and `EAUTH` / `ENOTADMIN` / `EPERM` as
  "administrator permission refused".
- **First run.** When the app opens and an enabled source reports `available && !ready`, the app starts
  `store:refresh` for that source.
- **UI stubs.** In DEV only, `AURORA_STORE_SOURCES_DIR=<absolute dir>` loads `ubuntu.js` and `flathub.js` from
  that directory instead. `test/store.test.mjs` uses the tiny stubs in `shell/test/fixtures/store-ui-sources/`.
- **In-process installs.** `store.js` also sets `api.storeService = { install(source, id, onProgress),
  installedIds(source), available(source) }` for other main modules. It runs the same code as `store:install`:
  one operation at a time (`EBUSY` otherwise), `store:progress` broadcasts, and `store:changed` once it finishes.
  `main/ipc/firstlogin.js` uses it to install the gaming apps chosen in the installer's « Jeux » step
  (`~/.config/aurora/first-login/gaming.json`, written by `aurora-install --gaming`), one after the other, at
  the first session. Those apps then show up in Installed like any other Flathub app.
  Tests: `test/gaming-setup.test.mjs` (stub `flatpak` through `AURORA_FLATPAK`, plus the stub source in
  `shell/test/fixtures/gaming-setup/`).
