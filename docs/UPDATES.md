# Selene updates

How Selene OS updates itself on installed systems: the shell, the apps, the helpers and Electron ship as Debian
packages from a signed apt repository, next to Ubuntu's own updates.

## What is packaged

| Package | Version | Content |
|---|---|---|
| `aurora-electron` | `<Electron version>-<rev>` (e.g. `44.7.0-1`) | the pinned Electron runtime, `/opt/aurora/electron` (SHA256-checked, en/fr locales only, `chrome-sandbox` root 4755) |
| `aurora-shell` | `<VERSION>-<build>` (e.g. `1.0.0-324`) | `/opt/aurora/shell` with its runtime `node_modules`; `Depends: aurora-electron (>= <Electron version>), aurora-base (>= <VERSION>)` |
| `aurora-base` | `<VERSION>-<build>` | the `rootfs/` overlay (session scripts, helpers, systemd units, greetd, sudoers, polkit, AppArmor, X11, apt bits), the Selene apt source and archive keyring |

- `VERSION` (repository root) holds the Selene version (`1.0.0`); the build number is `BUILD_NUMBER` or, by default,
  the number of git commits (every commit builds a newer package). The ISO name and os-release use `VERSION` too.
- `aurora-base`: every file under `/etc` is a conffile (an administrator's change is kept on update: Paramètres and
  `aurora-admin apt-upgrade` use `--force-confold`). Files that Ubuntu packages own
  (`packaging/aurora-base/diversions`: `/etc/greetd/config.toml`, `/etc/systemd/zram-generator.conf`) ship as
  `<file>.selene`; the preinst diverts Ubuntu's file to `<file>.ubuntu` (its package updates land there) and the
  postinst links `<file>` to `<file>.selene`. Removing aurora-base gives Ubuntu's files back. `/usr/lib/os-release` is
  diverted the same way (Ubuntu's copy in `os-release.ubuntu`) and rewritten by the postinst with the new version.
  On a running system the postinst also runs `systemctl daemon-reload`, `systemd-tmpfiles` and reloads the AppArmor
  profile; new `aurora-*` units with an `[Install]` section are enabled like `dh_installsystemd` does.
- A new file in `rootfs/` that an Ubuntu package already owns stops the image build with a message naming it: add it
  to `packaging/aurora-base/diversions`.
- `iso/build.sh` (system stage) builds the three packages (`tools/build-debs.sh`) and installs them with `dpkg -i`
  instead of copying files: the image content is the same, and `dpkg -S /opt/aurora/shell` answers `aurora-shell`
  (checked by `make verify-iso`).

## Building and publishing

```sh
make debs                       # out/debs/aurora-{electron,shell,base}_*.deb   (no root needed)
make repo                       # out/apt/: pool + dists/noble/main/binary-amd64, Release / InRelease / Release.gpg
make release VERSION=1.0.1      # VERSION bump, debs, repo, docs/releases/1.0.1.md skeleton (complete it)
sudo tools/test-selfupdate.sh   # install, update from the signed repo, failing-repo fallback, removal (throwaway root)
```

`out/apt/` is a plain static tree: publish it on any HTTPS static host, at the address in `SELENE_APT_URL`
(`iso/config.sh`, default `https://belzeeebuth.github.io/claudeai-test/apt/`). The pool keeps older versions so that
systems that have not updated yet still find their files: keep `out/apt/` between releases (or copy the published
tree back before `make repo`).

GitHub Pages (the default address): commit the content of `out/apt/` under `apt/` on the branch Pages serves (for
example a `gh-pages` branch), or upload it with the `actions/upload-pages-artifact` + `actions/deploy-pages` workflow.
`out/apt/.nojekyll` keeps Pages from processing the files. GitHub refuses files over 100 MB: `aurora-electron` is
~86 MB (xz); watch it when Electron grows (another host, or Git LFS is not an option for Pages).

## The archive key

- `tools/selene-key.sh ensure` (run by `make debs` / `make repo` when needed) creates the key once, RSA 4096,
  signing only, valid 5 years, in `keys/gnupg` (**gitignored, never commit it**; `SELENE_KEYS_DIR` puts it elsewhere,
  e.g. a removable disk), and exports the public keyring to `iso/keys/selene-archive-keyring.gpg` (committed).
- Back up `keys/` (offline). Without it no update can be signed for the systems already installed.
- The image ships the public key as `/usr/share/keyrings/selene-archive-keyring.gpg` and the source
  `/etc/apt/sources.list.d/selene.sources` with `Signed-By:` that keyring only (the key is trusted for this
  repository only, not for Ubuntu's).
- Renewing before expiry: `gpg --homedir keys/gnupg --quick-set-expire <fingerprint> 5y`, then
  `tools/selene-key.sh export` and publish an `aurora-base` (it carries the keyring) before the old date passes.
- Key rotation (lost or compromised key): create a new key, ship a release whose `aurora-base` contains both public
  keys in `iso/keys/selene-archive-keyring.gpg` (signed with the old key while it is still trusted), then sign with the
  new key only. A lost key cannot be rotated this way: installed systems must then import the new keyring by hand.

## How users get updates

Paramètres > Mises à jour (or `apt`): « Rechercher des mises à jour » runs `aurora-admin apt-check`; Selene's packages
are listed as one entry, « Selene 1.0.1 » (or « Selene — Electron x.y.z » when only Electron changes); « Tout
installer » (`aurora-admin apt-upgrade`) installs them with Ubuntu's. After a new `aurora-shell` or Electron the page
offers « Redémarrer la session » (sign out and back in: the running shell stays the old version until then; it
compares `/opt/aurora/shell/selene-version` with the version it started with, `main/ipc/selene-update.js`).
Electron security fixes ship as a new `aurora-electron` (bump `electron` in `shell/package.json` and its
`ELECTRON_SHA256` in `iso/config.sh`, then `make release`).

An unreachable, unpublished (404) or wrongly signed Selene repository never blocks Ubuntu updates: `aurora-admin`'s
`apt_update` (apt-check, Logithèque installs, the graphics drivers path with `--error-on=any`) retries `apt-get update`
without `selene.sources` when the first try fails. (`apt.systemd.daily` and a manual `apt update` only print a
warning for an unreachable repository, but stop on a 404 or a bad signature: publish the repository before shipping
images that point to it.)

Systems installed from an image built before Selene was packaged have no Selene source and no `aurora-*` packages: they
need one manual step (`sudo apt install ./aurora-*.deb` from the release, which also adds the source and the key).
