#!/bin/bash
# Selene OS — signed apt repository of the Selene packages (docs/UPDATES.md).
#
#   tools/build-repo.sh [--debs DIR] [--out DIR]       (make repo; no root needed)
#
# Adds the .debs of DIR (default out/debs) to the pool of out/apt/ (older versions already in the pool are kept,
# so that installed systems can still download them), then writes the indexes and signs them:
#   out/apt/pool/main/a/<pkg>/<pkg>_<ver>_amd64.deb
#   out/apt/dists/noble/main/binary-amd64/Packages{,.gz}  out/apt/dists/noble/{Release,InRelease,Release.gpg}
#   out/apt/selene-archive-keyring.gpg (the public key, for manual setups)
# Signed with the Selene archive key (tools/selene-key.sh; created on first use in the gitignored keys/).
# Self-contained (dpkg-deb, gzip, sha256sum, gpg): no apt-ftparchive / reprepro needed on the build host.
set -euo pipefail
AURORA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../iso/config.sh
source "$AURORA_ROOT/iso/config.sh"
DEBS="$OUT/debs"
REPO="$OUT/apt"
while (($#)); do
  case "$1" in
    --debs) DEBS="${2:?}"; shift 2 ;;
    --out) REPO="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "build-repo: unknown argument $1" >&2; exit 2 ;;
  esac
done
log() { printf '[build-repo] %s\n' "$*" >&2; }
die() { printf '[build-repo] ERROR: %s\n' "$*" >&2; exit 1; }

shopt -s nullglob
debs=("$DEBS"/*.deb)
((${#debs[@]})) || die "no .deb in $DEBS (run make debs first)"
"$AURORA_ROOT/tools/selene-key.sh" ensure
export GNUPGHOME="${SELENE_KEYS_DIR:-$AURORA_ROOT/keys}/gnupg"
FPR="$("$AURORA_ROOT/tools/selene-key.sh" fpr)"
[[ -n "$FPR" ]] || die "no Selene archive key"

for d in "${debs[@]}"; do
  pkg="$(dpkg-deb -f "$d" Package)"
  dest="$REPO/pool/main/${pkg:0:1}/$pkg"
  mkdir -p "$dest"
  cp -f "$d" "$dest/"
done

COMP_DIR="dists/$SUITE/main/binary-$ARCH"
mkdir -p "$REPO/$COMP_DIR"
# Packages: every .deb in the pool (control fields + Filename, Size, checksums), sorted for stable output.
{
  first=1
  while IFS= read -r rel; do
    f="$REPO/$rel"
    ((first)) || echo
    first=0
    dpkg-deb -f "$f" | grep -v '^$'
    echo "Filename: $rel"
    echo "Size: $(stat -c %s "$f")"
    echo "MD5sum: $(md5sum "$f" | cut -d' ' -f1)"
    echo "SHA1: $(sha1sum "$f" | cut -d' ' -f1)"
    echo "SHA256: $(sha256sum "$f" | cut -d' ' -f1)"
  done < <(cd "$REPO" && find pool -name '*.deb' | LC_ALL=C sort)
} >"$REPO/$COMP_DIR/Packages"
gzip -9nc "$REPO/$COMP_DIR/Packages" >"$REPO/$COMP_DIR/Packages.gz"
cat >"$REPO/$COMP_DIR/Release" <<EOF
Archive: $SUITE
Component: main
Origin: Selene OS
Label: Selene OS
Architecture: $ARCH
EOF

rel="$REPO/dists/$SUITE/Release"
{
  echo "Origin: Selene OS"
  echo "Label: Selene OS"
  echo "Suite: $SUITE"
  echo "Codename: $SUITE"
  echo "Version: $(tr -d ' \n' <"$AURORA_ROOT/VERSION")"
  echo "Date: $(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S UTC')"
  echo "Architectures: $ARCH"
  echo "Components: main"
  echo "Description: Selene OS updates (shell, apps, helpers, Electron)"
  for algo in MD5Sum:md5sum SHA1:sha1sum SHA256:sha256sum; do
    echo "${algo%%:*}:"
    for f in main/binary-$ARCH/Packages main/binary-$ARCH/Packages.gz main/binary-$ARCH/Release; do
      printf ' %s %16d %s\n' "$("${algo#*:}" "$REPO/dists/$SUITE/$f" | cut -d' ' -f1)" "$(stat -c %s "$REPO/dists/$SUITE/$f")" "$f"
    done
  done
} >"$rel"
rm -f "$REPO/dists/$SUITE/InRelease" "$REPO/dists/$SUITE/Release.gpg"
gpg --batch --yes --local-user "$FPR" --digest-algo SHA512 --clearsign -o "$REPO/dists/$SUITE/InRelease" "$rel"
gpg --batch --yes --local-user "$FPR" --digest-algo SHA512 -abs -o "$REPO/dists/$SUITE/Release.gpg" "$rel"
cp "$AURORA_ROOT/iso/keys/selene-archive-keyring.gpg" "$REPO/selene-archive-keyring.gpg"
# GitHub Pages: serve files as they are (no Jekyll processing).
touch "$REPO/.nojekyll"
log "repository $REPO: $(grep -c '^Package:' "$REPO/$COMP_DIR/Packages") package(s), signed by $FPR"
