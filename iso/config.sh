# shellcheck shell=bash
# shellcheck disable=SC2034  # variables are used by iso/build.sh, which sources this file
# Aurora OS — pinned build configuration.
#
# Sourced by iso/build.sh (and the Makefile/tools). Every value can be overridden from the
# environment, e.g.:   sudo SNAPSHOT=0 WITH_FIRMWARE=1 ./iso/build.sh
#
# Reproducibility: the package set comes from a dated snapshot of the Ubuntu archive
# (https://snapshot.ubuntu.com), Electron is pinned by shell/package.json and verified
# against its SHASUMS256.txt, npm dependencies are pinned by shell/package-lock.json, and
# every timestamp written into the image is clamped to SOURCE_DATE_EPOCH (the time of the
# last git commit).

# ---- locations -------------------------------------------------------------------------
AURORA_ROOT="${AURORA_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SHELL_SRC="${SHELL_SRC:-$AURORA_ROOT/shell}"
ROOTFS_SRC="${ROOTFS_SRC:-$AURORA_ROOT/rootfs}"
PACKAGES_DIR="${PACKAGES_DIR:-$AURORA_ROOT/iso/packages.d}"
WORK="${WORK:-$AURORA_ROOT/work}"         # scratch (chroot layers, ISO tree) — safe to delete
CACHE="${CACHE:-$AURORA_ROOT/cache}"      # downloads (debs, Electron, npm) — keep for fast rebuilds
OUT="${OUT:-$AURORA_ROOT/out}"            # final ISO

# ---- distribution ----------------------------------------------------------------------
SUITE="${SUITE:-noble}"
ARCH="${ARCH:-amd64}"
COMPONENTS="${COMPONENTS:-main restricted universe multiverse}"
# Pinned archive snapshot (https://snapshot.ubuntu.com). Bump SNAPSHOT_STAMP (alias: STAMP)
# deliberately to pick up updates; the format is YYYYMMDDTHHMMSSZ.
#   SNAPSHOT=1     use the snapshot (default, reproducible)
#   SNAPSHOT=0     use the live archive ($ARCHIVE_MIRROR): newest packages, not reproducible
#   SNAPSHOT=auto  use the snapshot when it is reachable, otherwise fall back to the archive
SNAPSHOT_STAMP="${SNAPSHOT_STAMP:-${STAMP:-20261001T000000Z}}"
SNAPSHOT="${SNAPSHOT:-1}"
ARCHIVE_MIRROR="${ARCHIVE_MIRROR:-http://archive.ubuntu.com/ubuntu}"
SNAPSHOT_MIRROR="${SNAPSHOT_MIRROR:-https://snapshot.ubuntu.com/ubuntu/$SNAPSHOT_STAMP}"
MIRROR_FROM_ENV=0
if [[ -n "${MIRROR:-}" ]]; then
  MIRROR_FROM_ENV=1
elif [[ "$SNAPSHOT" == 0 ]]; then
  MIRROR="$ARCHIVE_MIRROR"
else
  MIRROR="$SNAPSHOT_MIRROR"
fi
# Mirror written into the image for end users (apt update/upgrade after installation).
FINAL_MIRROR="${FINAL_MIRROR:-http://archive.ubuntu.com/ubuntu}"
FINAL_SECURITY_MIRROR="${FINAL_SECURITY_MIRROR:-http://security.ubuntu.com/ubuntu}"
KEYRING="${KEYRING:-/usr/share/keyrings/ubuntu-archive-keyring.gpg}"

# Kernel metapackage. linux-image-generic = GA kernel (6.8 on noble);
# linux-image-generic-hwe-24.04 = newer hardware-enablement kernel.
KERNEL_PACKAGE="${KERNEL_PACKAGE:-linux-image-generic}"
# 0 = no linux-firmware (VM-oriented, ~600 MB smaller); 1 = ship linux-firmware for real hardware.
WITH_FIRMWARE="${WITH_FIRMWARE:-0}"
# Packages are installed without Recommends so the image only contains what packages.d asks for.
INSTALL_RECOMMENDS="${INSTALL_RECOMMENDS:-0}"
# 1 = warn about (and skip) packages that do not exist instead of failing.
ALLOW_MISSING_PACKAGES="${ALLOW_MISSING_PACKAGES:-0}"

# ---- versions --------------------------------------------------------------------------
_aurora_json_field() { # file field
  sed -n "s/^[[:space:]]*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -n1
}
ELECTRON_VERSION="${ELECTRON_VERSION:-$(_aurora_json_field "$SHELL_SRC/package.json" electron)}"
ELECTRON_VERSION="${ELECTRON_VERSION#^}"; ELECTRON_VERSION="${ELECTRON_VERSION#~}"
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://github.com/electron/electron/releases/download}"
# Known-good SHA256 of electron-v<version>-linux-x64.zip, checked in addition to the release's
# SHASUMS256.txt (a version without an entry here is verified against SHASUMS256.txt only).
# Override for a new version with ELECTRON_SHA256=<hex>.
_aurora_electron_sha256_known() {
  case "$1" in
    44.7.0) echo 3ae7d5bdad61c664486c6ab61361dd084d064c8c08af8d13a687096e18ce555a ;;
  esac
}
ELECTRON_SHA256="${ELECTRON_SHA256:-$(_aurora_electron_sha256_known "$ELECTRON_VERSION")}"
# Electron UI locales kept in the image (others fall back to en-US).
ELECTRON_LOCALES="${ELECTRON_LOCALES:-en-US en-GB fr}"
NODE_BIN="${NODE_BIN:-/opt/node22/bin}"

ISO_VERSION="${ISO_VERSION:-$(_aurora_json_field "$SHELL_SRC/package.json" version)}"
ISO_VERSION="${ISO_VERSION:-1.0.0}"
OS_NAME="${OS_NAME:-Aurora OS}"
ISO_VOLID="${ISO_VOLID:-AURORA_OS}"
ISO_NAME="${ISO_NAME:-aurora-os-$ISO_VERSION-$ARCH.iso}"
ISO_PATH="${ISO_PATH:-$OUT/$ISO_NAME}"

# SOURCE_DATE_EPOCH: time of the last commit (falls back to "now" outside git).
if [[ -z "${SOURCE_DATE_EPOCH:-}" ]]; then
  SOURCE_DATE_EPOCH="$(git -C "$AURORA_ROOT" log -1 --format=%ct 2>/dev/null || true)"
  SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(date +%s)}"
fi
export SOURCE_DATE_EPOCH
GIT_REV="${GIT_REV:-$(git -C "$AURORA_ROOT" rev-parse --short=10 HEAD 2>/dev/null || echo unknown)}"
if [[ -z "${GIT_DIRTY:-}" ]]; then
  GIT_DIRTY=""
  if [[ -n "$(git -C "$AURORA_ROOT" status --porcelain -- . 2>/dev/null | head -n1)" ]]; then GIT_DIRTY="+dirty"; fi
fi
BUILD_DATE="$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y%m%d)"
BUILD_ID="${BUILD_ID:-$ISO_VERSION-$BUILD_DATE-$GIT_REV$GIT_DIRTY}"

# ---- live session ----------------------------------------------------------------------
LIVE_USER="${LIVE_USER:-aurora}"
LIVE_USER_FULLNAME="${LIVE_USER_FULLNAME:-Aurora Live}"
LIVE_HOSTNAME="${LIVE_HOSTNAME:-aurora}"
DEFAULT_LOCALE="${DEFAULT_LOCALE:-en_US.UTF-8}"
LOCALES="${LOCALES:-en_US.UTF-8 fr_FR.UTF-8}"
TIMEZONE="${TIMEZONE:-Etc/UTC}"

# ---- compression -----------------------------------------------------------------------
# zstd decompresses much faster than xz (matters for live boots, especially under emulation).
SQUASHFS_COMP="${SQUASHFS_COMP:-zstd}"
SQUASHFS_LEVEL="${SQUASHFS_LEVEL:-19}"
SQUASHFS_BLOCK="${SQUASHFS_BLOCK:-1M}"

# ---- network during the build ----------------------------------------------------------
# CA bundle trusted by apt *inside the chroot during the build only* (removed before
# squashing). Needed for https mirrors before ca-certificates exists in the chroot, and for
# TLS-intercepting proxies.
if [[ -z "${BUILD_CA_BUNDLE:-}" ]]; then
  for _c in /root/.ccr/ca-bundle.crt "${SSL_CERT_FILE:-}" /etc/ssl/certs/ca-certificates.crt; do
    if [[ -n "$_c" && -r "$_c" ]]; then BUILD_CA_BUNDLE="$_c"; break; fi
  done
  unset _c
fi
BUILD_CA_BUNDLE="${BUILD_CA_BUNDLE:-}"
BUILD_HTTPS_PROXY="${BUILD_HTTPS_PROXY:-${https_proxy:-${HTTPS_PROXY:-}}}"
BUILD_HTTP_PROXY="${BUILD_HTTP_PROXY:-${http_proxy:-}}"
