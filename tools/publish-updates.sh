#!/bin/bash
# Selene OS — publish the signed apt repository out/apt/ (made by `sudo make docker-repo`) on GitHub Pages.
#
#   tools/publish-updates.sh [--remote URL] [--dir DIR] [--dry-run]       (make publish-updates)
#
# SELENE_APT_URL (iso/config.sh) is https://<user>.github.io/<path>/: the public repository <user>/<user>.github.io
# (GitHub Pages « user site », served from its default branch) holds out/apt/ under <path>/, so installed systems
# reach it without the main repository being public. Runs as you, not root: git pushes with your own credentials.
# Before pushing it checks that InRelease is signed by the key the images trust (iso/keys/selene-archive-keyring.gpg)
# and that no file is over GitHub's 100 MB limit. docs/UPDATES.md has the whole procedure.
set -euo pipefail
AURORA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELENE_APT_URL="$(sed -n 's/^SELENE_APT_URL="\${SELENE_APT_URL:-\(.*\)}"$/\1/p' "$AURORA_ROOT/iso/config.sh" | head -n1)"
SELENE_APT_URL="${SELENE_APT_URL_OVERRIDE:-$SELENE_APT_URL}"
REPO="$AURORA_ROOT/out/apt"
KEYRING="$AURORA_ROOT/iso/keys/selene-archive-keyring.gpg"
DIR="${XDG_CACHE_HOME:-$HOME/.cache}/selene-pages"
REMOTE=""
DRY=0
while (($#)); do
  case "$1" in
    --remote) REMOTE="${2:?}"; shift 2 ;;
    --dir) DIR="${2:?}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "publish-updates: unknown argument $1" >&2; exit 2 ;;
  esac
done
log() { printf '[publish-updates] %s\n' "$*" >&2; }
die() { printf '[publish-updates] ERROR: %s\n' "$*" >&2; exit 1; }

[[ $EUID -ne 0 ]] || die "run it as yourself, not with sudo (git must use your GitHub credentials)"
for t in git gpgv; do command -v "$t" >/dev/null 2>&1 || die "$t is required"; done

# https://<user>.github.io/<path>/ -> <user>, <path>
[[ "$SELENE_APT_URL" =~ ^https://([A-Za-z0-9-]+)\.github\.io/([A-Za-z0-9._/-]+[A-Za-z0-9._-])/?$ ]] \
  || die "SELENE_APT_URL ($SELENE_APT_URL) is not a https://<user>.github.io/<path>/ address"
GH_USER="${BASH_REMATCH[1]}"
SUBPATH="${BASH_REMATCH[2]}"
[[ "$SUBPATH" != *..* ]] || die "bad path in SELENE_APT_URL"
REMOTE="${REMOTE:-https://github.com/$GH_USER/$GH_USER.github.io.git}"

# The repository to publish: signed by the key the images ship, nothing GitHub would refuse.
[[ -s "$REPO/dists/noble/InRelease" ]] || die "no $REPO/dists/noble/InRelease: run « sudo make docker-repo » first"
[[ -s "$KEYRING" ]] || die "no $KEYRING: build the ISO / packages on this machine first (it creates the key)"
gpgv --keyring "$KEYRING" "$REPO/dists/noble/InRelease" >/dev/null 2>&1 \
  || die "out/apt is not signed by the key in iso/keys/selene-archive-keyring.gpg: installed systems would refuse it"
big="$(find "$REPO" -type f -size +99M -printf '%P\n' | head -n5)"
[[ -z "$big" ]] || die "files over GitHub's 100 MB limit: $big"
versions="$(find "$REPO/pool" -name '*.deb' -printf '%f\n' | sed 's/_amd64\.deb$//' | sort -V | tail -n3 | tr '\n' ' ')"

# The Pages repository, cloned once in $DIR (only this script writes there).
if [[ -d "$DIR/.git" ]]; then
  log "updating $DIR"
  git -C "$DIR" fetch -q origin
  git -C "$DIR" reset -q --hard "origin/$(git -C "$DIR" rev-parse --abbrev-ref origin/HEAD | sed 's|^origin/||')"
else
  log "cloning $REMOTE into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone -q "$REMOTE" "$DIR" || die "could not clone $REMOTE (create the public repository $GH_USER.github.io on GitHub first: docs/UPDATES.md)"
fi
dest="$DIR/$SUBPATH"
rm -rf -- "$dest"
mkdir -p "$dest"
cp -a "$REPO/." "$dest/"
touch "$DIR/.nojekyll"   # serve the files as they are (no Jekyll processing)
git -C "$DIR" add -A
if git -C "$DIR" diff --cached --quiet; then
  log "nothing new to publish ($versions)"
  exit 0
fi
git -C "$DIR" commit -q -m "Selene updates: $versions"
if ((DRY)); then
  log "dry run: committed in $DIR, not pushed"
  exit 0
fi
git -C "$DIR" push -q origin HEAD
log "published $versions"
log "GitHub Pages updates the site in about a minute. Check: curl -fsI ${SELENE_APT_URL%/}/dists/noble/InRelease"
log "Then on Selene: Paramètres > Mises à jour > Rechercher des mises à jour."
