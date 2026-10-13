#!/bin/bash
# Selene OS — build Selene's own Debian packages from the repository (docs/UPDATES.md).
#
#   tools/build-debs.sh [--out DIR] [--force-electron]      (make debs; no root needed)
#
#   aurora-electron  <electron version>-<ELECTRON_PKG_REV>   /opt/aurora/electron (pinned, SHA256-checked Electron)
#   aurora-shell     <VERSION>-<BUILD_NUMBER>                /opt/aurora/shell (+ runtime node_modules)
#   aurora-base      <VERSION>-<BUILD_NUMBER>                rootfs/ overlay, /etc files as conffiles, the Selene apt
#                                                            source + archive keyring, maintainer scripts
# VERSION comes from the VERSION file, BUILD_NUMBER from the environment (default: number of git commits, so that
# every commit builds a newer package). Output (default out/debs): exactly one .deb per package.
# The aurora-electron .deb is reused when one of the same version is already in the output directory.
set -euo pipefail

AURORA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../iso/config.sh
source "$AURORA_ROOT/iso/config.sh"

OUT_DIR="$OUT/debs"
FORCE_ELECTRON=0
while (($#)); do
  case "$1" in
    --out) OUT_DIR="${2:?--out needs a directory}"; shift 2 ;;
    --out=*) OUT_DIR="${1#*=}"; shift ;;
    --force-electron) FORCE_ELECTRON=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "build-debs: unknown argument $1" >&2; exit 2 ;;
  esac
done

log() { printf '[build-debs] %s\n' "$*" >&2; }
die() { printf '[build-debs] ERROR: %s\n' "$*" >&2; exit 1; }

SELENE_VERSION="$(tr -d ' \n' <"$AURORA_ROOT/VERSION")"
[[ "$SELENE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "VERSION must be x.y.z (got '$SELENE_VERSION')"
BUILD_NUMBER="${BUILD_NUMBER:-$(git -C "$AURORA_ROOT" rev-list --count HEAD 2>/dev/null || echo 0)}"
[[ "$BUILD_NUMBER" =~ ^[0-9]+$ ]] || die "BUILD_NUMBER must be a number"
PKG_VERSION="$SELENE_VERSION-$BUILD_NUMBER"
ELECTRON_PKG_VERSION="$ELECTRON_VERSION-${ELECTRON_PKG_REV:-1}"
STAGE="${DEBS_STAGING:-$WORK/staging/debs}"
DEB_COMPRESS=(-Zxz -z6)
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# control file from packaging/<pkg>/control (+ conffiles, maintainer scripts), then dpkg-deb.
make_deb() { # pkg version root
  local pkg="$1" ver="$2" root="$3" f size
  mkdir -p "$root/DEBIAN"
  size="$(du -sk --exclude=DEBIAN "$root" | cut -f1)"
  sed -e "s/@VERSION@/$ver/g" -e "s/@SIZE@/$size/g" -e "s/@ELECTRON_VERSION@/$ELECTRON_VERSION/g" \
      -e "s/@UPSTREAM@/$SELENE_VERSION/g" "$AURORA_ROOT/packaging/$pkg/control" >"$root/DEBIAN/control"
  for f in preinst postinst prerm postrm; do
    [[ -f "$AURORA_ROOT/packaging/$pkg/$f" ]] || continue
    sed -e "s|@DIVERSIONS@|${DIVERSIONS:-}|g" -e "s|@UNITS@|${UNITS:-}|g" -e "s/@UPSTREAM@/$SELENE_VERSION/g" \
      "$AURORA_ROOT/packaging/$pkg/$f" >"$root/DEBIAN/$f"
    chmod 0755 "$root/DEBIAN/$f"
  done
  if [[ -d "$root/etc" ]]; then
    (cd "$root" && find etc -type f | sed 's|^|/|' | LC_ALL=C sort) >"$root/DEBIAN/conffiles"
  fi
  find "$root" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
  rm -f "$OUT_DIR/${pkg}"_*.deb
  dpkg-deb --root-owner-group "${DEB_COMPRESS[@]}" --build "$root" "$OUT_DIR/${pkg}_${ver}_$ARCH.deb" >/dev/null
  log "$pkg $ver ($(du -h "$OUT_DIR/${pkg}_${ver}_$ARCH.deb" | cut -f1))"
}

# ---- aurora-electron ------------------------------------------------------------------
build_electron() {
  local deb="$OUT_DIR/aurora-electron_${ELECTRON_PKG_VERSION}_$ARCH.deb"
  if [[ "$FORCE_ELECTRON" == 0 && -s "$deb" ]]; then log "aurora-electron $ELECTRON_PKG_VERSION already built"; return; fi
  local v="$ELECTRON_VERSION" zip sums name="electron-v$ELECTRON_VERSION-linux-x64.zip" want
  mkdir -p "$CACHE/electron"
  zip="${ELECTRON_ZIP:-$CACHE/electron/$name}"
  sums="$CACHE/electron/SHASUMS256-v$v.txt"
  local curl_opts=(--fail --location --silent --show-error --retry 4 --retry-delay 3 --connect-timeout 30)
  if [[ -n "${ELECTRON_ZIP:-}" ]]; then
    # Tests: a local zip, checked against ELECTRON_SHA256 only.
    want="$(sha256sum "$zip" | cut -d' ' -f1)"
    [[ "$want" == "${ELECTRON_SHA256:-}" ]] || die "ELECTRON_ZIP does not match ELECTRON_SHA256"
  else
    if [[ ! -s "$sums" ]]; then
      log "downloading SHASUMS256.txt for Electron $v"
      curl "${curl_opts[@]}" -o "$sums.part" "$ELECTRON_MIRROR/v$v/SHASUMS256.txt"
      mv "$sums.part" "$sums"
    fi
    want="$(awk -v n="$name" '$2 == n || $2 == "*" n {print $1}' "$sums")"
    [[ "$want" =~ ^[0-9a-f]{64}$ ]] || die "no checksum for $name in SHASUMS256.txt"
    if [[ -n "$ELECTRON_SHA256" ]]; then
      # The pinned checksum (iso/config.sh) must agree with the release's SHASUMS256.txt.
      [[ "$want" == "$ELECTRON_SHA256" ]] || { rm -f "$sums"; die "SHASUMS256.txt of Electron $v disagrees with the pinned ELECTRON_SHA256 ($ELECTRON_SHA256)"; }
    else
      log "WARNING: no pinned SHA256 for Electron $v in iso/config.sh — trusting the release's SHASUMS256.txt ($want)"
    fi
    if [[ ! -s "$zip" ]] || [[ "$(sha256sum "$zip" | cut -d' ' -f1)" != "$want" ]]; then
      log "downloading $name"
      curl "${curl_opts[@]}" -o "$zip.part" "$ELECTRON_MIRROR/v$v/$name"
      mv "$zip.part" "$zip"
    fi
  fi
  [[ "$(sha256sum "$zip" | cut -d' ' -f1)" == "$want" ]] || { rm -f "$zip"; die "SHA256 mismatch for $name"; }
  log "Electron $v verified (sha256 $want)"
  local root="$STAGE/aurora-electron" dest
  rm -rf "$root"; dest="$root/opt/aurora/electron"; mkdir -p "$dest"
  unzip -q "$zip" -d "$dest"
  # Keep only the UI locales the OS ships (en/fr); everything else falls back to en-US.
  local keep=" $ELECTRON_LOCALES " f base
  for f in "$dest"/locales/*.pak; do
    [[ -f "$f" ]] || continue
    base="$(basename "$f" .pak)"
    [[ "$keep" == *" $base "* ]] || rm -f "$f"
  done
  echo "$v" >"$dest/version.aurora"
  chmod -R u+rwX,go+rX,go-w "$root"
  [[ -f "$dest/chrome-sandbox" ]] && chmod 4755 "$dest/chrome-sandbox"
  make_deb aurora-electron "$ELECTRON_PKG_VERSION" "$root"
}

# ---- aurora-shell ---------------------------------------------------------------------
npm_ci_runtime() { # dir
  cd "$1" || return 1
  export PATH="$NODE_BIN:$PATH" npm_config_cache="$CACHE/npm" npm_config_update_notifier=false
  if [[ -n "$BUILD_CA_BUNDLE" ]]; then export NODE_EXTRA_CA_CERTS="$BUILD_CA_BUNDLE"; fi
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline --loglevel=error || return 1
  # npm cannot always tell glibc from musl here and then also installs the musl builds of prebuilt
  # native modules (e.g. @napi-rs/canvas, an optional dependency of pdfjs-dist). The image is glibc.
  find node_modules -mindepth 1 -maxdepth 2 -type d -name '*-linux-*-musl*' -prune -exec rm -rf {} +
}

build_shell() {
  local root="$STAGE/aurora-shell" dest p
  rm -rf "$root"; dest="$root/opt/aurora/shell"; mkdir -p "$dest"
  log "staging the Selene Shell (npm ci --omit=dev)"
  for p in package.json package-lock.json main preload renderer; do
    [[ -e "$SHELL_SRC/$p" ]] || die "missing $SHELL_SRC/$p"
    cp -a "$SHELL_SRC/$p" "$dest/"
  done
  if [[ -n "${SHELL_NODE_MODULES:-}" ]]; then
    cp -a "$SHELL_NODE_MODULES" "$dest/node_modules"   # tests: prebuilt modules, no npm
  else
    (npm_ci_runtime "$dest") || die "npm ci failed for the shell"
  fi
  rm -f "$dest/node_modules/.package-lock.json"
  # Read by the shell (main/ipc/selene-update.js) to offer « Redémarrer la session » after an update.
  echo "$PKG_VERSION" >"$dest/selene-version"
  chmod -R u+rwX,go+rX,go-w "$root"
  make_deb aurora-shell "$PKG_VERSION" "$root"
}

# ---- aurora-base ----------------------------------------------------------------------
build_base() {
  local root="$STAGE/aurora-base" f
  rm -rf "$root"; mkdir -p "$root"
  [[ -d "$ROOTFS_SRC" ]] || die "$ROOTFS_SRC is missing"
  # Same selection as the image always had: no development leftovers (bytecode caches, editor backups).
  tar -C "$ROOTFS_SRC" --exclude='.gitkeep' --exclude='./README*' --exclude='__pycache__' --exclude='*.pyc' \
      --exclude='*~' --exclude='.*.swp' -cf - . | tar -C "$root" -xf -
  chmod -R u+rwX,go+rX,go-w "$root"
  # Executables (git only tracks the x bit; enforce it for the documented entry points).
  for f in "$root"/usr/bin/aurora-* "$root"/usr/lib/aurora/aurora-* "$root"/usr/lib/aurora/helpers/* \
           "$root"/usr/lib/aurora/autoinstall/aurora-*; do
    [[ -f "$f" ]] && chmod 0755 "$f"
  done
  for f in "$root"/etc/netplan/*.yaml; do [[ -f "$f" ]] && chmod 0600 "$f"; done
  for f in "$root"/etc/sudoers.d/aurora*; do [[ -f "$f" ]] && chmod 0440 "$f"; done
  # Selene apt repository: archive keyring + deb822 source (docs/UPDATES.md).
  local keyring="$AURORA_ROOT/iso/keys/selene-archive-keyring.gpg"
  [[ -s "$keyring" ]] || "$AURORA_ROOT/tools/selene-key.sh" ensure
  install -D -m 0644 "$keyring" "$root/usr/share/keyrings/selene-archive-keyring.gpg"
  install -d -m 0755 "$root/etc/apt/sources.list.d"
  cat >"$root/etc/apt/sources.list.d/selene.sources" <<EOF
# Selene OS updates (shell, apps, helpers, Electron). Signed with the Selene archive key.
# Ubuntu updates keep working when this repository cannot be reached.
Types: deb
URIs: $SELENE_APT_URL
Suites: $SUITE
Components: main
Architectures: $ARCH
Signed-By: /usr/share/keyrings/selene-archive-keyring.gpg
EOF
  chmod 0644 "$root/etc/apt/sources.list.d/selene.sources"
  DIVERSIONS="$(grep -E '^/' "$AURORA_ROOT/packaging/aurora-base/diversions" | tr '\n' ' ' | sed 's/ $//')"
  for f in $DIVERSIONS; do
    [[ -f "$root$f" ]] || die "packaging/aurora-base/diversions: $f is not in rootfs/"
    mv "$root$f" "$root$f.selene"   # displaced: postinst links $f -> $f.selene
  done
  UNITS=""
  for f in "$root"/usr/lib/systemd/system/aurora-* "$root"/etc/systemd/system/aurora-*; do
    [[ -f "$f" ]] || continue
    case "$f" in *.service|*.timer|*.socket|*.path) ;; *) continue ;; esac
    grep -q '^\[Install\]' "$f" && UNITS+="${UNITS:+ }$(basename "$f")"
  done
  make_deb aurora-base "$PKG_VERSION" "$root"
}

SELENE_APT_URL="${SELENE_APT_URL:-https://belzeeebuth.github.io/claudeai-test/apt/}"
build_electron
build_base
build_shell
log "packages in $OUT_DIR"
