#!/usr/bin/env bash
# Selene OS — live/installable ISO builder.
#
#   sudo ./iso/build.sh                 full build -> out/selene-os-<version>-amd64.iso
#   sudo ./iso/build.sh --until system  stop after a stage (base|packages|system|squashfs|iso)
#   sudo ./iso/build.sh --from squashfs start at a stage (earlier stages must have run before)
#   sudo ./iso/build.sh --rebuild-packages   ignore the cached package layer
#   sudo ./iso/build.sh --clean         remove work/ first (keeps cache/)
#
# The whole output is also written to work/logs/build-<date>.log (work/logs/latest.log).
#
# Stages (each one logs its duration):
#   base      debootstrap --variant=minbase, cached as cache/base/<key>.tar.zst
#   packages  apt install of iso/packages.d/*.list into work/layers/packages
#             (reused while its inputs are unchanged; package additions are applied in place)
#   system    overlay on top of the package layer: Electron, Selene Shell, rootfs/ overlay,
#             system configuration, casper, Plymouth theme, initramfs, cleanup
#   squashfs  manifests + casper/filesystem.squashfs
#   iso       ISO tree, themed GRUB menu, hybrid BIOS+UEFI image (grub-mkrescue/xorriso)
#
# Configuration lives in iso/config.sh (every value can be overridden from the environment).
set -Eeuo pipefail
umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=iso/config.sh
source "$HERE/config.sh"

STAGES=(base packages system squashfs iso)
UNTIL=iso
FROM=base
REBUILD_PACKAGES=0
CLEAN=0

usage() {
  sed -n '2,/^set -E/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

while (($#)); do
  case "$1" in
    --until) UNTIL="${2:?--until needs a stage}"; shift 2 ;;
    --until=*) UNTIL="${1#*=}"; shift ;;
    --from) FROM="${2:?--from needs a stage}"; shift 2 ;;
    --from=*) FROM="${1#*=}"; shift ;;
    --rebuild-packages) REBUILD_PACKAGES=1; shift ;;
    --clean) CLEAN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "build.sh: unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------------------
# logging
# ---------------------------------------------------------------------------------------
if [[ -t 2 ]]; then C_B=$'\e[1;34m'; C_G=$'\e[1;32m'; C_Y=$'\e[1;33m'; C_R=$'\e[1;31m'; C_0=$'\e[0m'
else C_B=; C_G=; C_Y=; C_R=; C_0=; fi
BUILD_T0=$(date +%s)
log()  { printf '%s[aurora %s]%s %s\n' "$C_B" "$(date +%H:%M:%S)" "$C_0" "$*" >&2; }
ok()   { printf '%s[aurora %s]%s %s\n' "$C_G" "$(date +%H:%M:%S)" "$C_0" "$*" >&2; }
warn() { printf '%s[aurora %s] WARNING:%s %s\n' "$C_Y" "$(date +%H:%M:%S)" "$C_0" "$*" >&2; }
die()  { printf '%s[aurora %s] ERROR:%s %s\n' "$C_R" "$(date +%H:%M:%S)" "$C_0" "$*" >&2; exit 1; }
STAGE_T0=0
stage() { STAGE_T0=$(date +%s); printf '\n%s==== stage: %s ====%s\n' "$C_B" "$1" "$C_0" >&2; }
stage_done() { ok "stage $1 done in $(( $(date +%s) - STAGE_T0 ))s"; }
stage_index() { local i; for i in "${!STAGES[@]}"; do [[ "${STAGES[$i]}" == "$1" ]] && { echo "$i"; return 0; }; done; return 1; }
stage_enabled() { # stage -> true when it lies between --from and --until
  local i f u
  i="$(stage_index "$1")"; f="$(stage_index "$FROM")"; u="$(stage_index "$UNTIL")"
  ((i >= f && i <= u))
}
# grep for a fixed string in a variable (no pipes: avoids SIGPIPE under pipefail)
has_text() { grep -qF -- "$1" <<<"$2"; }

# ---------------------------------------------------------------------------------------
# mounts + cleanup (everything under $WORK is unmounted on exit, even on failure)
# ---------------------------------------------------------------------------------------
umount_under() { # path: unmount every mount point below (and including) path, deepest first
  local base mp
  base="$(readlink -f "$1" 2>/dev/null || echo "$1")"
  while read -r mp; do
    [[ -z "$mp" ]] && continue
    umount "$mp" 2>/dev/null || umount -l "$mp" 2>/dev/null || warn "could not unmount $mp"
  done < <(findmnt -rn -o TARGET | awk -v b="$base" '$0 == b || index($0, b "/") == 1' | sort -r)
}

LOCK_FD=
LOG_FILE=
BG_PID=""

# Long-running commands (debootstrap, apt-get, npm, update-initramfs, mksquashfs) run through
# run_bg: bash only runs a signal trap once the *foreground* command has finished, so a SIGTERM
# (or Ctrl+C) would otherwise wait for a 4-minute mksquashfs. "wait" is interrupted at once; the
# EXIT trap then stops the command (and its children) before unmounting.
run_bg() { # cmd...  (a command or a shell function)
  local rc=0
  "$@" &
  BG_PID=$!
  wait "$BG_PID" || rc=$?
  BG_PID=""
  return "$rc"
}
# shellcheck disable=SC2317  # invoked from cleanup
kill_tree() { # pid signal: children first, then the process itself
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c" "$2"; done
  kill "-$2" "$1" 2>/dev/null || true
}
# shellcheck disable=SC2317  # invoked from cleanup
stop_bg() {
  [[ -n "$BG_PID" ]] && kill -0 "$BG_PID" 2>/dev/null || return 0
  warn "stopping the running command ($(ps -o comm= -p "$BG_PID" 2>/dev/null || echo "pid $BG_PID"))"
  kill_tree "$BG_PID" TERM
  local i
  for ((i = 0; i < 100; i++)); do kill -0 "$BG_PID" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$BG_PID" 2>/dev/null && kill_tree "$BG_PID" KILL
  wait "$BG_PID" 2>/dev/null || true
  BG_PID=""
}

# shellcheck disable=SC2317  # invoked through trap
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  stop_bg
  if [[ -d "$WORK" ]]; then umount_under "$WORK"; fi
  if ((rc != 0)); then
    printf '%s[aurora] build FAILED (exit %d) after %ss%s\n' "$C_R" "$rc" "$(( $(date +%s) - BUILD_T0 ))" "$C_0" >&2
    [[ -n "$LOG_FILE" ]] && printf '[aurora] full log: %s\n' "$LOG_FILE" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A private, minimal /dev for the build chroot. Never bind the host's /dev: maintainer scripts
# (systemd-tmpfiles' static-nodes-permissions.conf, udev) would then chown/chmod the HOST's device
# nodes with the image's group IDs — e.g. /dev/kvm became root:994 0660, and on an Arch host
# (where 994 is not the kvm group) the user lost KVM after every packages stage.
mount_private_dev() { # dir
  local d="$1" n
  mount -t tmpfs -o mode=0755,nosuid tmpfs "$d"
  for n in "null 1 3" "zero 1 5" "full 1 7" "random 1 8" "urandom 1 9" "tty 5 0"; do
    set -- $n
    # mknod needs CAP_MKNOD; without it, bind the single host node (only these harmless ones).
    mknod -m 666 "$d/$1" c "$2" "$3" 2>/dev/null || { : >"$d/$1"; mount --bind "/dev/$1" "$d/$1"; }
  done
  mkdir -p "$d/pts" "$d/shm"
  mount -t devpts -o newinstance,ptmxmode=0666,mode=0620 devpts "$d/pts"
  ln -s pts/ptmx "$d/ptmx"
  mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$d/shm"
  ln -s /proc/self/fd "$d/fd"
  ln -s /proc/self/fd/0 "$d/stdin"; ln -s /proc/self/fd/1 "$d/stdout"; ln -s /proc/self/fd/2 "$d/stderr"
}

chroot_mount() { # root
  local r="$1"
  mkdir -p "$r/proc" "$r/sys" "$r/dev" "$r/run" "$r/tmp"
  mountpoint -q "$r/proc" || mount -t proc proc "$r/proc"
  mountpoint -q "$r/sys" || mount -t sysfs sysfs "$r/sys" 2>/dev/null || mount --rbind -o ro /sys "$r/sys"
  mountpoint -q "$r/dev" || mount_private_dev "$r/dev"
  mountpoint -q "$r/run" || mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs "$r/run"
  mkdir -p "$r/run/lock" "$r/run/systemd"
  # Let maintainer scripts know they run in a build chroot; never start services.
  printf '#!/bin/sh\n# aurora build: do not start daemons in the chroot\nexit 101\n' >"$r/usr/sbin/policy-rc.d"
  chmod 755 "$r/usr/sbin/policy-rc.d"
  # DNS for the build (the image's own resolv.conf is restored by chroot_umount).
  if [[ -e "$r/etc/resolv.conf" || -L "$r/etc/resolv.conf" ]] && [[ ! -e "$r/etc/resolv.conf.aurora-build" && ! -L "$r/etc/resolv.conf.aurora-build" ]]; then
    mv "$r/etc/resolv.conf" "$r/etc/resolv.conf.aurora-build"
  fi
  rm -f "$r/etc/resolv.conf"
  cp -L /etc/resolv.conf "$r/etc/resolv.conf"
}

chroot_umount() { # root
  local r="$1"
  rm -f "$r/usr/sbin/policy-rc.d"
  if [[ -e "$r/etc/resolv.conf.aurora-build" || -L "$r/etc/resolv.conf.aurora-build" ]]; then
    rm -f "$r/etc/resolv.conf"
    mv "$r/etc/resolv.conf.aurora-build" "$r/etc/resolv.conf"
  fi
  local m
  umount_under "$r/dev"  # the private /dev's pts, shm and any bound nodes
  for m in var/cache/apt/archives run dev sys proc; do
    if mountpoint -q "$r/$m"; then umount "$r/$m" 2>/dev/null || umount -l "$r/$m"; fi
  done
  umount_under "$r/sys"
}

in_chroot() { # root cmd...
  local r="$1"; shift
  chroot "$r" /usr/bin/env -i \
    HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=dumb \
    DEBIAN_FRONTEND=noninteractive DEBCONF_NONINTERACTIVE_SEEN=true DEBCONF_NOWARNINGS=yes \
    SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
    "$@"
}

apt_in() { # root apt-get args...  (interruptible: see run_bg)
  local r="$1"; shift
  run_bg in_chroot "$r" apt-get -y -q -o Dpkg::Use-Pty=0 -o APT::Color=0 "$@"
}

sha256_of_text() { sha256sum | cut -c1-16; }

# ---------------------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------------------
start_log() { # tee everything (stdout+stderr) into work/logs/
  local d="$WORK/logs"
  mkdir -p "$d"
  LOG_FILE="$d/build-$(date +%Y%m%d-%H%M%S).log"
  ln -sfn "$(basename "$LOG_FILE")" "$d/latest.log"
  # Terminal output keeps its colours; the log file gets plain text.
  exec > >(tee >(sed -u $'s/\e\\[[0-9;]*m//g' >>"$LOG_FILE")) 2>&1
  # Keep the 10 most recent logs.
  find "$d" -maxdepth 1 -name 'build-*.log' -printf '%T@ %p\n' | sort -rn | tail -n +11 | cut -d' ' -f2- \
    | xargs -r rm -f
}

# Is the package mirror reachable? (InRelease of the suite)
mirror_reachable() { # url
  local opts=(--fail --silent --show-error --location --head --max-time 30 --retry 2 --retry-delay 2)
  [[ -n "$BUILD_CA_BUNDLE" ]] && opts+=(--cacert "$BUILD_CA_BUNDLE")
  env ${BUILD_HTTPS_PROXY:+https_proxy="$BUILD_HTTPS_PROXY"} ${BUILD_HTTP_PROXY:+http_proxy="$BUILD_HTTP_PROXY"} \
    curl "${opts[@]}" -o /dev/null "$1/dists/$SUITE/InRelease"
}

check_mirror() {
  if mirror_reachable "$MIRROR"; then
    ok "mirror reachable: $MIRROR"
    return
  fi
  if [[ "$SNAPSHOT" == auto && "$MIRROR_FROM_ENV" == 0 ]]; then
    warn "snapshot mirror $MIRROR is not reachable — SNAPSHOT=auto falls back to $ARCHIVE_MIRROR (build not reproducible)"
    MIRROR="$ARCHIVE_MIRROR"; SNAPSHOT=0
    mirror_reachable "$MIRROR" || die "the archive mirror $MIRROR is not reachable either (network/proxy?)"
    return
  fi
  # Not fatal yet: cached layers may make the network unnecessary. debootstrap/apt fail
  # loudly later if packages really have to be downloaded.
  warn "cannot reach $MIRROR/dists/$SUITE/InRelease — the build fails if packages must be downloaded.
  Check the network/proxy (https_proxy, BUILD_CA_BUNDLE), or build from the live archive
  with SNAPSHOT=0 (or SNAPSHOT=auto to fall back automatically)."
}

preflight() {
  [[ "$ARCH" == amd64 ]] || die "only ARCH=amd64 is supported"
  case "$SNAPSHOT" in 0|1|auto) ;; *) die "SNAPSHOT must be 0, 1 or auto (got '$SNAPSHOT')" ;; esac
  [[ "$SNAPSHOT_STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "SNAPSHOT_STAMP must look like 20261001T000000Z (got '$SNAPSHOT_STAMP')"
  local missing=() t
  for t in debootstrap chroot mount mountpoint findmnt flock mksquashfs unsquashfs xorriso grub-mkrescue \
           grub-mkfont mformat rsvg-convert convert unzip curl sha256sum dpkg-deb tar zstd md5sum; do
    command -v "$t" >/dev/null 2>&1 || missing+=("$t")
  done
  [[ -x "$NODE_BIN/npm" ]] || command -v npm >/dev/null 2>&1 || missing+=("npm (node 22)")
  [[ -d /usr/lib/grub/i386-pc ]] || missing+=("grub-pc-bin")
  [[ -d /usr/lib/grub/x86_64-efi ]] || missing+=("grub-efi-amd64-bin")
  # The session scripts must be in the checkout (a download that lost them or their executable bit
  # would otherwise fail only at the end of the system stage, half an hour later).
  local f bad=()
  for f in usr/bin/aurora-shell usr/bin/aurora-session usr/lib/aurora/aurora-greeter usr/lib/aurora/aurora-xsession \
           usr/lib/aurora/aurora-xstart usr/lib/aurora/aurora-xgreeter; do
    [[ -f "$ROOTFS_SRC/$f" ]] || { bad+=("$f (missing)"); continue; }
    [[ -x "$ROOTFS_SRC/$f" ]] || bad+=("$f (not executable)")
    [[ "$(head -c 2 "$ROOTFS_SRC/$f")" == '#!' ]] || bad+=("$f (the first line must start with #!)")
  done
  ((${#bad[@]} == 0)) || die "incomplete rootfs/ in $ROOTFS_SRC: ${bad[*]} — update the checkout (git pull) or run: chmod +x rootfs/usr/bin/* rootfs/usr/lib/aurora/aurora-*"
  ((${#missing[@]} == 0)) || die "missing build tools: ${missing[*]}
  On Ubuntu/Debian: apt-get install debootstrap squashfs-tools xorriso grub-pc-bin grub-efi-amd64-bin \\
    grub-common mtools dosfstools librsvg2-bin imagemagick unzip curl zstd  (+ Node.js 22)"
  [[ -r "$KEYRING" ]] || die "Ubuntu archive keyring not found at $KEYRING (apt-get install ubuntu-keyring)"
  [[ -n "$ELECTRON_VERSION" ]] || die "could not read the Electron version from $SHELL_SRC/package.json"
  [[ -f "$SHELL_SRC/package-lock.json" ]] || die "$SHELL_SRC/package-lock.json is missing (npm ci needs it)"
  [[ -d "$PACKAGES_DIR" ]] || die "$PACKAGES_DIR is missing"
  if [[ "$MIRROR" == https://* && -z "$BUILD_CA_BUNDLE" ]]; then
    die "https mirror $MIRROR needs a CA bundle (set BUILD_CA_BUNDLE) — or use SNAPSHOT=0"
  fi
  local avail_gb
  avail_gb=$(( $(df -Pk "$WORK" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
  ((avail_gb >= 8)) || die "only ${avail_gb} GB free under $WORK (need ~10 GB for a rebuild, ~20 GB for the first build)"
  ((avail_gb >= 15)) || warn "only ${avail_gb} GB free under $WORK; a first build needs ~20 GB"
  umount_under "$WORK"   # leftovers from an interrupted run
  if stage_enabled base || stage_enabled packages; then check_mirror; fi

  log "$OS_NAME $ISO_VERSION  build-id $BUILD_ID"
  log "suite=$SUITE arch=$ARCH mirror=$MIRROR (snapshot=$SNAPSHOT)"
  log "electron=$ELECTRON_VERSION kernel=$KERNEL_PACKAGE firmware=$WITH_FIRMWARE recommends=$INSTALL_RECOMMENDS"
  log "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH ($(date -u -d "@$SOURCE_DATE_EPOCH" '+%F %T') UTC)"
  log "work=$WORK cache=$CACHE out=$OUT"
}

# ---------------------------------------------------------------------------------------
# stage: base (debootstrap)
# ---------------------------------------------------------------------------------------
BASE_KEY=""
BASE_TARBALL=""
compute_base_key() {
  BASE_KEY="$(printf '%s\n' "rev=2" "$SUITE" "$ARCH" "$MIRROR" "minbase" | sha256_of_text)"
  BASE_TARBALL="$CACHE/base/$SUITE-$ARCH-minbase-$BASE_KEY.tar.zst"
}

stage_base() {
  stage base
  compute_base_key
  if [[ -s "$BASE_TARBALL" ]]; then
    log "reusing cached debootstrap tarball $(basename "$BASE_TARBALL")"
    stage_done base; return
  fi
  local tmp="$WORK/debootstrap"
  umount_under "$tmp"; rm -rf "$tmp"; mkdir -p "$tmp" "$CACHE/debootstrap-debs" "$CACHE/base"
  log "debootstrap $SUITE ($MIRROR) — debs cached in $CACHE/debootstrap-debs"
  local env_proxy=()
  [[ -n "$BUILD_HTTPS_PROXY" ]] && env_proxy+=("https_proxy=$BUILD_HTTPS_PROXY")
  [[ -n "$BUILD_HTTP_PROXY" ]] && env_proxy+=("http_proxy=$BUILD_HTTP_PROXY")
  [[ -n "$BUILD_CA_BUNDLE" ]] && env_proxy+=("SSL_CERT_FILE=$BUILD_CA_BUNDLE")
  run_bg env "${env_proxy[@]}" debootstrap --variant=minbase --arch="$ARCH" --merged-usr \
    --components="${COMPONENTS// /,}" --keyring="$KEYRING" \
    --cache-dir="$CACHE/debootstrap-debs" \
    "$SUITE" "$tmp" "$MIRROR" \
    || { [[ -f "$tmp/debootstrap/debootstrap.log" ]] && tail -n 40 "$tmp/debootstrap/debootstrap.log" >&2; die "debootstrap failed"; }
  umount_under "$tmp"
  log "saving base tarball"
  tar --numeric-owner --xattrs --xattrs-include='*' -C "$tmp" -cf - . | zstd -q -T0 -10 -o "$BASE_TARBALL.part"
  mv "$BASE_TARBALL.part" "$BASE_TARBALL"
  rm -rf "$tmp"
  stage_done base
}

# ---------------------------------------------------------------------------------------
# stage: packages
# ---------------------------------------------------------------------------------------
PKG_LAYER="$WORK/layers/packages"

# Prints "package<TAB>source-file" for every requested package (deduplicated, first wins).
collect_packages() {
  local f line
  shopt -s nullglob
  local lists=("$PACKAGES_DIR"/*.list)
  shopt -u nullglob
  ((${#lists[@]})) || die "no package lists in $PACKAGES_DIR"
  {
    printf '%s\t%s\n' "$KERNEL_PACKAGE" "config.sh:KERNEL_PACKAGE"
    if [[ "$WITH_FIRMWARE" == 1 ]]; then   # desktop firmware only (aurora-firmware-desktop Provides linux-firmware)
      for f in $FIRMWARE_PACKAGES; do
        [[ "$f" =~ ^[a-z0-9][a-z0-9+.-]*$ ]] || die "invalid package name '$f' in FIRMWARE_PACKAGES"
        printf '%s\t%s\n' "$f" "config.sh:FIRMWARE_PACKAGES"
      done
    fi
    for f in "${lists[@]}"; do
      while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%%#*}"
        line="$(echo "$line" | tr -d '[:space:]')"
        [[ -z "$line" ]] && continue
        if [[ ! "$line" =~ ^[a-z0-9][a-z0-9+.:-]*(=[^[:space:]]+)?$ ]]; then
          die "invalid package name '$line' in $(basename "$f")"
        fi
        printf '%s\t%s\n' "$line" "$(basename "$f")"
      done <"$f"
    done
  } | awk -F'\t' '!seen[$1]++'
}

packages_key() { # -> hash of everything except the package list itself
  {
    echo "rev=4"
    echo "$BASE_KEY"
    echo "$MIRROR $COMPONENTS $INSTALL_RECOMMENDS $WITH_FIRMWARE $KERNEL_PACKAGE"
    [[ "$WITH_FIRMWARE" == 1 ]] && echo "firmware: $FIRMWARE_PACKAGES"
    write_dpkg_excludes /dev/stdout "$KEEP_MANPAGES"
  } | sha256_of_text
}

# Manual pages are kept (English and French) when a package list asks for man-db (Terminal);
# otherwise they are not installed at all. Set by stage_packages from the requested packages.
KEEP_MANPAGES=0

write_dpkg_excludes() { # file keep-manpages(0|1)
  {
    cat <<'EOF'
# Selene OS: keep the image small (documentation, manual pages and translations other than
# English/French are not installed). Copyright files are kept.
# Remove this file and reinstall packages to get the full content back.
path-exclude=/usr/share/doc/*
path-include=/usr/share/doc/*/copyright
path-exclude=/usr/share/man/*
EOF
    if [[ "${2:-0}" == 1 ]]; then
      echo 'path-include=/usr/share/man/man*'
      echo 'path-include=/usr/share/man/fr*'
    fi
    cat <<'EOF'
path-exclude=/usr/share/info/*
path-exclude=/usr/share/groff/*
path-exclude=/usr/share/lintian/*
path-exclude=/usr/share/linda/*
path-exclude=/usr/share/locale/*
path-include=/usr/share/locale/locale.alias
path-include=/usr/share/locale/en*
path-include=/usr/share/locale/fr*
path-exclude=/usr/share/help/*
path-include=/usr/share/help/C/*
path-include=/usr/share/help/fr*
EOF
  } >"$1"
}

write_build_sources() { # root
  local r="$1"
  rm -f "$r/etc/apt/sources.list"
  mkdir -p "$r/etc/apt/sources.list.d"
  cat >"$r/etc/apt/sources.list.d/ubuntu.sources" <<EOF
# Selene OS build-time sources (replaced by the final archive sources before squashing)
Types: deb
URIs: $MIRROR
Suites: $SUITE $SUITE-updates $SUITE-security
Components: $COMPONENTS
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
Check-Valid-Until: no
EOF
}

write_final_sources() { # root
  local r="$1"
  rm -f "$r/etc/apt/sources.list"
  cat >"$r/etc/apt/sources.list" <<'EOF'
# Ubuntu sources have moved to /etc/apt/sources.list.d/ubuntu.sources
EOF
  cat >"$r/etc/apt/sources.list.d/ubuntu.sources" <<EOF
Types: deb
URIs: $FINAL_MIRROR
Suites: $SUITE $SUITE-updates $SUITE-backports
Components: $COMPONENTS
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: $FINAL_SECURITY_MIRROR
Suites: $SUITE-security
Components: $COMPONENTS
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
}

# Build-time apt network settings (CA + proxy). Removed by apt_net_off before squashing.
apt_net_on() { # root
  local r="$1"
  {
    echo '// Selene OS build-time apt settings — removed before the image is squashed'
    echo 'Acquire::Retries "5";'
    echo 'Acquire::Languages "none";'
    echo 'Acquire::http::Timeout "60";'
    echo 'Acquire::https::Timeout "60";'
    if [[ -n "$BUILD_CA_BUNDLE" ]]; then
      cp "$BUILD_CA_BUNDLE" "$r/etc/apt/aurora-build-ca.crt"
      echo 'Acquire::https::CAInfo "/etc/apt/aurora-build-ca.crt";'
    fi
    [[ -n "$BUILD_HTTPS_PROXY" ]] && echo "Acquire::https::Proxy \"$BUILD_HTTPS_PROXY\";"
    [[ -n "$BUILD_HTTP_PROXY" ]] && echo "Acquire::http::Proxy \"$BUILD_HTTP_PROXY\";"
    if [[ "$INSTALL_RECOMMENDS" != 1 ]]; then
      echo 'APT::Install-Recommends "false";'
      echo 'APT::Install-Suggests "false";'
    fi
    echo 'Dpkg::Options { "--force-confdef"; "--force-confold"; };'
  } >"$r/etc/apt/apt.conf.d/99aurora-build"
}

apt_net_off() { # root
  rm -f "$1/etc/apt/apt.conf.d/99aurora-build" "$1/etc/apt/aurora-build-ca.crt"
}

# Kernel/initramfs hooks are pointless while packages are being installed: the initramfs is
# generated once, at the end of the system stage.
divert_initramfs() { # root
  local r="$1"
  if ! has_text aurora-build "$(in_chroot "$r" dpkg-divert --list /usr/sbin/update-initramfs)"; then
    in_chroot "$r" dpkg-divert --local --rename --divert /usr/sbin/update-initramfs.aurora-build \
      --add /usr/sbin/update-initramfs >/dev/null
  fi
  printf '#!/bin/sh\necho "update-initramfs: deferred by the Selene OS build" >&2\nexit 0\n' >"$r/usr/sbin/update-initramfs"
  chmod 755 "$r/usr/sbin/update-initramfs"
}

undivert_initramfs() { # root
  local r="$1"
  if has_text aurora-build "$(in_chroot "$r" dpkg-divert --list /usr/sbin/update-initramfs)"; then
    rm -f "$r/usr/sbin/update-initramfs"
    in_chroot "$r" dpkg-divert --local --rename --divert /usr/sbin/update-initramfs.aurora-build \
      --remove /usr/sbin/update-initramfs >/dev/null
  fi
}

build_firmware_placeholder() { # -> path of .deb
  local d="$WORK/debs/aurora-firmware-placeholder"
  rm -rf "$d"; mkdir -p "$d/DEBIAN" "$d/usr/share/doc/aurora-firmware-placeholder"
  cat >"$d/DEBIAN/control" <<'EOF'
Package: aurora-firmware-placeholder
Version: 1.0
Architecture: all
Maintainer: Selene OS <aurora-os@localhost>
Provides: linux-firmware
Section: kernel
Priority: optional
Description: placeholder for linux-firmware (Selene OS build without firmware)
 This Selene OS image was built with WITH_FIRMWARE=0 for virtual machines and does not
 ship the large linux-firmware collection. Install the real "linux-firmware" package
 for physical hardware (Wi-Fi, GPUs...); this placeholder can then be removed.
EOF
  printf 'Selene OS firmware placeholder. Public domain.\n' >"$d/usr/share/doc/aurora-firmware-placeholder/copyright"
  find "$d" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
  dpkg-deb --root-owner-group -Zxz --build "$d" "$WORK/debs/aurora-firmware-placeholder_1.0_all.deb" >/dev/null
  echo "$WORK/debs/aurora-firmware-placeholder_1.0_all.deb"
}

# WITH_FIRMWARE=1: Provides linux-firmware (the kernel metapackage depends on it) and depends on the desktop firmware
# sub-packages of FIRMWARE_PACKAGES, so the server-only ones of the linux-firmware metapackage are never installed.
build_firmware_desktop() { # -> path of .deb
  local d="$WORK/debs/aurora-firmware-desktop" deps
  deps="$(printf '%s\n' $FIRMWARE_PACKAGES | paste -sd, - | sed 's/,/, /g')"
  [[ -n "$deps" ]] || die "FIRMWARE_PACKAGES is empty"
  rm -rf "$d"; mkdir -p "$d/DEBIAN" "$d/usr/share/doc/aurora-firmware-desktop"
  cat >"$d/DEBIAN/control" <<EOF
Package: aurora-firmware-desktop
Version: 1.0
Architecture: all
Maintainer: Selene OS <aurora-os@localhost>
Provides: linux-firmware
Depends: $deps
Section: kernel
Priority: optional
Description: firmware for desktop and laptop hardware (Selene OS)
 Stands in for the linux-firmware metapackage: installs its desktop sub-packages
 (graphics, Wi-Fi, Bluetooth, audio DSPs...) but not the server-only ones (Mellanox
 Spectrum, Marvell Prestera, Netronome, QLogic). Installing the real linux-firmware
 metapackage instead is harmless.
EOF
  printf 'Selene OS firmware selection. Public domain.\n' >"$d/usr/share/doc/aurora-firmware-desktop/copyright"
  find "$d" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
  dpkg-deb --root-owner-group -Zxz --build "$d" "$WORK/debs/aurora-firmware-desktop_1.0_all.deb" >/dev/null
  echo "$WORK/debs/aurora-firmware-desktop_1.0_all.deb"
}

# Check that every requested package exists; print a clear report otherwise.
validate_packages() { # root pkglist-file(pkg<TAB>source)
  local r="$1" list="$2" missing
  cp "$list" "$r/tmp/aurora-packages.tsv"
  cat >"$r/tmp/aurora-validate.sh" <<'EOS'
#!/bin/bash
# prints "pkg<TAB>source" for every package apt cannot install
while IFS=$'\t' read -r p src; do
  name="${p%%=*}"
  cand="$(apt-cache policy "$name" 2>/dev/null | awk '/Candidate:/ {print $2; exit}')"
  if [[ -z "$cand" || "$cand" == "(none)" ]]; then
    # a virtual package with at least one provider is fine
    providers="$(apt-cache showpkg "$name" 2>/dev/null | awk '/^Reverse Provides:/ {f=1; next} f && NF {print $1}')"
    [[ -n "$providers" ]] || printf '%s\t%s\n' "$p" "$src"
  fi
done </tmp/aurora-packages.tsv
EOS
  missing="$(in_chroot "$r" /bin/bash /tmp/aurora-validate.sh)"
  rm -f "$r/tmp/aurora-packages.tsv" "$r/tmp/aurora-validate.sh"
  if [[ -n "$missing" ]]; then
    {
      echo
      echo "The following packages requested in $PACKAGES_DIR do not exist in $SUITE ($MIRROR):"
      awk -F'\t' '{printf "    %-40s (from %s)\n", $1, $2}' <<<"$missing"
      echo "Fix the package names in those .list files (check with: apt-cache policy <name>),"
      echo "or rerun with ALLOW_MISSING_PACKAGES=1 to skip them."
      echo
    } >&2
    if [[ "$ALLOW_MISSING_PACKAGES" == 1 ]]; then
      warn "skipping $(wc -l <<<"$missing") missing package(s) (ALLOW_MISSING_PACKAGES=1)"
      cut -f1 <<<"$missing" >"$WORK/missing-packages.txt"
    else
      # Nothing was installed yet: put the layer back in its normal state (no build-time apt
      # network settings, no policy-rc.d, original resolv.conf) so that it stays reusable.
      apt_net_off "$r"
      chroot_umount "$r"
      die "missing packages (see above)"
    fi
  else
    : >"$WORK/missing-packages.txt"
  fi
}

preseed_debconf() { # root
  in_chroot "$1" debconf-set-selections <<'EOF'
keyboard-configuration keyboard-configuration/layoutcode string us
keyboard-configuration keyboard-configuration/modelcode string pc105
keyboard-configuration keyboard-configuration/variantcode string
keyboard-configuration keyboard-configuration/xkb-keymap select us
console-setup console-setup/charmap47 select UTF-8
console-setup console-setup/codeset47 select Guess optimal character set
tzdata tzdata/Areas select Etc
tzdata tzdata/Zones/Etc select UTC
EOF
}

install_packages() { # root mode(full|incremental) pkg-tsv [layer-stamp]
  # layer-stamp: the cache key file of an existing layer, removed once the layer is about to be
  # modified (after the package names were validated), so an interrupted install rebuilds it.
  local r="$1" mode="$2" tsv="$3" stamp="${4:-}" pkgs=() extra=()
  chroot_mount "$r"
  mkdir -p "$CACHE/apt/archives/partial"
  mount --bind "$CACHE/apt/archives" "$r/var/cache/apt/archives"
  write_build_sources "$r"
  apt_net_on "$r"
  divert_initramfs "$r"
  write_dpkg_excludes "$r/etc/dpkg/dpkg.cfg.d/aurora-excludes" "$KEEP_MANPAGES"
  # Snaps are not part of Selene OS: never let a transitional package pull snapd in.
  cat >"$r/etc/apt/preferences.d/aurora-no-snap.pref" <<'EOF'
# Selene OS does not use snaps.
Package: snapd
Pin: release a=*
Pin-Priority: -10
EOF
  ln -sf /usr/share/zoneinfo/Etc/UTC "$r/etc/localtime"
  echo "Etc/UTC" >"$r/etc/timezone"

  log "apt-get update ($MIRROR)"
  apt_in "$r" update || die "apt-get update failed inside the chroot (mirror $MIRROR unreachable?)"
  # Proves that apt inside the chroot really reaches the configured mirror.
  local policy; policy="$(in_chroot "$r" apt-cache policy)"
  has_text "${MIRROR#*://}" "$policy" || die "apt in the chroot does not see $MIRROR"
  ok "apt inside the chroot reaches $MIRROR"
  preseed_debconf "$r"

  validate_packages "$r" "$tsv"
  if [[ -n "$stamp" ]]; then rm -f "$stamp"; fi
  local skip=""
  [[ -s "$WORK/missing-packages.txt" ]] && skip="$(cat "$WORK/missing-packages.txt")"
  local p
  while IFS=$'\t' read -r p _; do
    if [[ -n "$skip" ]] && grep -qxF "$p" <<<"$skip"; then continue; fi
    pkgs+=("$p")
  done <"$tsv"
  local deb
  if [[ "$WITH_FIRMWARE" != 1 ]]; then deb="$(build_firmware_placeholder)"; else deb="$(build_firmware_desktop)"; fi
  cp "$deb" "$r/tmp/"
  extra+=("/tmp/$(basename "$deb")")

  if [[ "$mode" == full ]]; then
    log "apt-get dist-upgrade (base system -> $SUITE-updates/-security)"
    apt_in "$r" dist-upgrade
  fi
  log "installing ${#pkgs[@]} packages (+dependencies)"
  apt_in "$r" install "${extra[@]}" "${pkgs[@]}" || die "apt-get install failed"
  rm -f "$r"/tmp/aurora-firmware-placeholder_*.deb "$r"/tmp/aurora-firmware-desktop_*.deb
  # Packages pulled in only as dependencies of removed lists are cleaned up as well.
  apt_in "$r" autoremove --purge
  # Unmount the shared .deb cache *before* "apt-get clean", which would otherwise empty it.
  umount "$r/var/cache/apt/archives" 2>/dev/null || umount -l "$r/var/cache/apt/archives"
  apt_in "$r" clean
  apt_net_off "$r"
  chroot_umount "$r"
  log "deb cache: $(find "$CACHE/apt/archives" -maxdepth 1 -name '*.deb' | wc -l) packages, $(du -sh "$CACHE/apt/archives" | cut -f1)"
}

stage_packages() {
  stage packages
  compute_base_key
  local key tsv="$WORK/packages.tsv"
  collect_packages >"$tsv"
  KEEP_MANPAGES=0
  if grep -qx man-db <<<"$(cut -f1 "$tsv")"; then KEEP_MANPAGES=1; fi
  key="$(packages_key)"
  local stamp_key="$PKG_LAYER.key" stamp_list="$PKG_LAYER.packages"
  log "$(wc -l <"$tsv") packages requested from $(find "$PACKAGES_DIR" -maxdepth 1 -name '*.list' | wc -l) list(s)"

  if ((REBUILD_PACKAGES == 0)) && [[ -d "$PKG_LAYER" && -f "$stamp_key" && -f "$stamp_list" ]] \
     && [[ "$(cat "$stamp_key")" == "$key" ]]; then
    local added removed
    added="$(comm -13 <(cut -f1 "$stamp_list" | sort -u) <(cut -f1 "$tsv" | sort -u))"
    removed="$(comm -23 <(cut -f1 "$stamp_list" | sort -u) <(cut -f1 "$tsv" | sort -u))"
    if [[ -z "$added" && -z "$removed" ]]; then
      log "package layer is up to date — reusing $PKG_LAYER"
      stage_done packages; return
    fi
    if [[ -z "$removed" ]]; then
      log "package lists gained: $(echo "$added" | tr '\n' ' ')— installing them into the existing layer"
      install_packages "$PKG_LAYER" incremental "$tsv" "$stamp_key"
      cp "$tsv" "$stamp_list"; echo "$key" >"$stamp_key"
      stage_done packages; return
    fi
    log "packages removed from the lists ($(echo "$removed" | tr '\n' ' ')) — rebuilding the layer"
  fi

  umount_under "$WORK/layers"
  rm -rf "$PKG_LAYER" "$stamp_key" "$stamp_list"
  mkdir -p "$PKG_LAYER"
  log "unpacking base system"
  zstd -q -dc "$BASE_TARBALL" | tar --numeric-owner --xattrs --xattrs-include='*' -C "$PKG_LAYER" -xf -
  install_packages "$PKG_LAYER" full "$tsv"
  cp "$tsv" "$stamp_list"
  echo "$key" >"$stamp_key"
  log "package layer: $(du -sh --apparent-size "$PKG_LAYER" | cut -f1)"
  stage_done packages
}

# ---------------------------------------------------------------------------------------
# stage: system (overlay on top of the package layer)
# ---------------------------------------------------------------------------------------
ROOT="$WORK/chroot"
SYS_UPPER="$WORK/layers/system"

mount_system_overlay() {
  umount_under "$ROOT"
  mkdir -p "$ROOT" "$SYS_UPPER/upper" "$SYS_UPPER/work"
  mount -t overlay overlay -o "lowerdir=$PKG_LAYER,upperdir=$SYS_UPPER/upper,workdir=$SYS_UPPER/work" "$ROOT"
}

# Selene's own files (Electron runtime, shell, rootfs/ overlay) come from its Debian packages, built by
# tools/build-debs.sh (aurora-electron, aurora-shell, aurora-base) and installed with dpkg, so that installed systems
# update them from the Selene apt repository (docs/UPDATES.md). The image content is the same as a plain copy.
install_selene_debs() {
  local out="$WORK/debs/selene" d f owner
  log "building the Selene packages (tools/build-debs.sh)"
  run_bg env WORK="$WORK" CACHE="$CACHE" OUT="$OUT" "$AURORA_ROOT/tools/build-debs.sh" --out "$out" \
    || die "building the Selene packages failed"
  local debs=("$out"/aurora-electron_*.deb "$out"/aurora-base_*.deb "$out"/aurora-shell_*.deb)
  for d in "${debs[@]}"; do [[ -s "$d" ]] || die "missing Selene package $d"; done
  # dpkg refuses to overwrite another package's file: name the file and the list that allows it.
  local diverted
  diverted=" $(grep -E '^/' "$AURORA_ROOT/packaging/aurora-base/diversions" | tr '\n' ' ') "
  while IFS= read -r f; do
    f="${f#.}"
    owner="$(in_chroot "$ROOT" dpkg-query -S "$f" 2>/dev/null | head -n1 | cut -d: -f1 || true)"
    [[ -z "$owner" || "$diverted" == *" $f "* || "$owner" == aurora-* || "$owner" == diversion* ]] && continue
    die "rootfs$f belongs to Ubuntu's $owner: add it to packaging/aurora-base/diversions (or move it out of the way)"
  done < <(dpkg-deb --fsys-tarfile "$out"/aurora-base_*.deb | tar -t | grep -v '/$')
  rm -rf "$ROOT/tmp/selene-debs"; mkdir -p "$ROOT/tmp/selene-debs"
  cp "${debs[@]}" "$ROOT/tmp/selene-debs/"
  local in_root=()
  for d in "${debs[@]}"; do in_root+=("/tmp/selene-debs/$(basename "$d")"); done
  in_chroot "$ROOT" dpkg -i "${in_root[@]}" </dev/null >/dev/null || die "dpkg -i of the Selene packages failed"
  rm -rf "$ROOT/tmp/selene-debs"
  for d in aurora-electron aurora-base aurora-shell; do
    in_chroot "$ROOT" dpkg-query -W -f='${Status}' "$d" | grep -q 'install ok installed' || die "$d is not installed"
  done
  if [[ -d "$ROOT/etc/sudoers.d" ]]; then
    for f in "$ROOT"/etc/sudoers.d/aurora*; do
      [[ -f "$f" ]] || continue
      in_chroot "$ROOT" visudo -c -q -f "/etc/sudoers.d/$(basename "$f")" || die "sudoers syntax error in $f"
    done
  fi
  log "Selene packages installed: $(in_chroot "$ROOT" dpkg-query -W -f='${Package} ${Version}, ' aurora-electron aurora-base aurora-shell)"
  log "shell: $(du -sh "$ROOT/opt/aurora/shell" | cut -f1) ($(find "$ROOT/opt/aurora/shell/node_modules" -maxdepth 2 -name package.json | wc -l) npm packages)"
}

write_os_identity() {
  # os-release: keep ID=ubuntu / ID_LIKE=debian (and the Ubuntu codename) for compatibility,
  # brand everything users see. A local diversion keeps it across base-files upgrades.
  # (--no-rename + copy: base-files is Essential, its os-release must never be missing.)
  if ! has_text os-release.ubuntu "$(in_chroot "$ROOT" dpkg-divert --list /usr/lib/os-release)"; then
    cp -a "$ROOT/usr/lib/os-release" "$ROOT/usr/lib/os-release.ubuntu"
    in_chroot "$ROOT" dpkg-divert --local --no-rename --divert /usr/lib/os-release.ubuntu --add /usr/lib/os-release >/dev/null
  fi
  local src="$ROOT/usr/lib/os-release.ubuntu"
  grep -q '^ID=ubuntu$' "$src" || die "$src is not Ubuntu's os-release"
  {
    echo "PRETTY_NAME=\"$OS_NAME $ISO_VERSION\""
    echo "NAME=\"$OS_NAME\""
    grep -E '^VERSION_ID=' "$src"
    echo "VERSION=\"$ISO_VERSION (based on Ubuntu $(sed -n 's/^VERSION="\(.*\)"/\1/p' "$src" | sed 's/ (.*//'))\""
    grep -E '^(VERSION_CODENAME|ID|ID_LIKE|HOME_URL|SUPPORT_URL|BUG_REPORT_URL|PRIVACY_POLICY_URL|UBUNTU_CODENAME)=' "$src"
    echo "LOGO=aurora-logo"
    echo "IMAGE_ID=aurora-os"
    echo "IMAGE_VERSION=$ISO_VERSION"
    echo "BUILD_ID=$BUILD_ID"
  } >"$ROOT/usr/lib/os-release"
  ln -sf ../usr/lib/os-release "$ROOT/etc/os-release"
  # Bug reports and support go to the Selene project, not to Launchpad (track "robust").
  sed -i -e '/^SUPPORT_URL=/d' -e '/^BUG_REPORT_URL=/d' "$ROOT/usr/lib/os-release"
  printf '%s\n' 'SUPPORT_URL="https://github.com/Belzeeebuth/claudeai-test/issues"' \
    'BUG_REPORT_URL="https://github.com/Belzeeebuth/claudeai-test/issues"' >>"$ROOT/usr/lib/os-release"
  grep -q '^ID=ubuntu$' "$ROOT/usr/lib/os-release" || die "os-release lost ID=ubuntu"

  sed -i "s/^DISTRIB_DESCRIPTION=.*/DISTRIB_DESCRIPTION=\"$OS_NAME $ISO_VERSION\"/" "$ROOT/etc/lsb-release"
  printf '%s %s \\n \\l\n\n' "$OS_NAME" "$ISO_VERSION" >"$ROOT/etc/issue"
  printf '%s %s\n' "$OS_NAME" "$ISO_VERSION" >"$ROOT/etc/issue.net"
  mkdir -p "$ROOT/etc/aurora"
  echo "$BUILD_ID" >"$ROOT/etc/aurora/build-id"
  cat >"$ROOT/etc/aurora/build-info" <<EOF
AURORA_VERSION=$ISO_VERSION
AURORA_BUILD_ID=$BUILD_ID
AURORA_GIT_REV=$GIT_REV$GIT_DIRTY
AURORA_SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH
AURORA_SUITE=$SUITE
AURORA_SNAPSHOT=$([[ "$SNAPSHOT" == 1 ]] && echo "$SNAPSHOT_STAMP" || echo none)
AURORA_ELECTRON=$ELECTRON_VERSION
AURORA_FIRMWARE=$WITH_FIRMWARE
EOF
  [[ -f "$ROOT/etc/aurora/settings.json" ]] || echo '{}' >"$ROOT/etc/aurora/settings.json"
}

configure_locale_time() {
  local l gen="$ROOT/etc/locale.gen"
  : >"$gen.aurora"
  for l in $LOCALES; do echo "$l ${l#*.}" >>"$gen.aurora"; done
  mv "$gen.aurora" "$gen"
  in_chroot "$ROOT" locale-gen >/dev/null
  in_chroot "$ROOT" update-locale --reset "LANG=$DEFAULT_LOCALE"
  ln -sf "/usr/share/zoneinfo/$TIMEZONE" "$ROOT/etc/localtime"
  echo "$TIMEZONE" >"$ROOT/etc/timezone"
  echo "$LIVE_HOSTNAME" >"$ROOT/etc/hostname"
  cat >"$ROOT/etc/hosts" <<EOF
127.0.0.1	localhost
127.0.1.1	$LIVE_HOSTNAME

# The following lines are desirable for IPv6 capable hosts
::1     ip6-localhost ip6-loopback
fe00::0 ip6-localnet
ff00::0 ip6-mcastprefix
ff02::1 ip6-allnodes
ff02::2 ip6-allrouters
EOF
}

configure_skel() {
  local d
  for d in Desktop Documents Downloads Pictures Music Videos; do
    mkdir -p "$ROOT/etc/skel/$d"
  done
  mkdir -p "$ROOT/etc/skel/.config"
}

configure_casper() {
  cat >"$ROOT/etc/casper.conf" <<EOF
# Selene OS live session (read by casper in the initramfs)
export USERNAME="$LIVE_USER"
export USERFULLNAME="$LIVE_USER_FULLNAME"
export HOST="$LIVE_HOSTNAME"
export BUILD_SYSTEM="Ubuntu"
# A non-empty FLAVOUR makes casper honour USERNAME and HOST above.
export FLAVOUR="Selene"
EOF
}

configure_services() {
  local u f
  in_chroot "$ROOT" systemctl set-default graphical.target >/dev/null
  # aurora-apparmor.service loads the Selene Shell AppArmor profile in the live session, where
  # Ubuntu's apparmor.service does not run (Chromium's sandbox needs the profile's userns rule).
  for u in greetd.service NetworkManager.service systemd-resolved.service ufw.service apparmor.service \
           aurora-apparmor.service; do
    in_chroot "$ROOT" systemctl enable "$u" >/dev/null 2>&1 || die "cannot enable $u"
  done
  # NetworkManager is the network stack; networkd (and its wait-online) only slow the boot down.
  for u in systemd-networkd.service systemd-networkd.socket systemd-networkd-wait-online.service; do
    in_chroot "$ROOT" systemctl disable "$u" >/dev/null 2>&1 || true
  done
  in_chroot "$ROOT" systemctl mask systemd-networkd-wait-online.service >/dev/null
  # Bluetooth (iso/packages.d/bluetooth.list): bluetoothd at boot; the session talks to it without root.
  if [[ -f "$ROOT/usr/lib/systemd/system/bluetooth.service" || -f "$ROOT/lib/systemd/system/bluetooth.service" ]]; then
    in_chroot "$ROOT" systemctl enable bluetooth.service >/dev/null 2>&1 || die "cannot enable bluetooth.service"
  fi
  # Printing (iso/packages.d/printing.list): CUPS (socket- and path-activated, and started at boot so that queued jobs
  # resume) and Avahi (DNS-SD: network printers, IPP-over-USB printers announced by ipp-usb, *.local names).
  # ipp-usb itself is started by udev when an IPP-over-USB printer is plugged in.
  if [[ -f "$ROOT/usr/lib/systemd/system/cups.service" ]]; then
    for u in cups.socket cups.path cups.service avahi-daemon.socket avahi-daemon.service; do
      in_chroot "$ROOT" systemctl enable "$u" >/dev/null 2>&1 || die "cannot enable $u"
    done
  fi
  # Screen reader (iso/packages.d/screen-reader.list): speech-dispatcher runs per user through its user socket (Orca
  # and spd-say connect to it); the system-wide speech-dispatcherd.service stays off.
  if [[ -f "$ROOT/usr/lib/systemd/user/speech-dispatcher.socket" ]]; then
    in_chroot "$ROOT" systemctl --global enable speech-dispatcher.socket >/dev/null 2>&1 || die "cannot enable speech-dispatcher.socket (user)"
    in_chroot "$ROOT" systemctl disable speech-dispatcherd.service >/dev/null 2>&1 || true
  fi
  # Firmware updates (iso/packages.d/firmware-updates.list): fwupd.service is D-Bus activated (Paramètres reads the
  # devices without root); fwupd-refresh.timer downloads the LVFS metadata once a day.
  if [[ -f "$ROOT/usr/lib/systemd/system/fwupd-refresh.timer" ]]; then
    in_chroot "$ROOT" systemctl enable fwupd-refresh.timer >/dev/null 2>&1 || die "cannot enable fwupd-refresh.timer"
  fi
  # Low memory (iso/packages.d/robust.list, track "robust"): earlyoom kills the biggest app before the kernel OOM
  # killer freezes the desktop; /etc/default/aurora-earlyoom (rootfs/) keeps Xorg, greetd and the shell last.
  if [[ -f "$ROOT/usr/lib/systemd/system/earlyoom.service" ]]; then
    in_chroot "$ROOT" systemctl enable earlyoom.service >/dev/null 2>&1 || die "cannot enable earlyoom.service"
  fi
  # Text console on tty1 stays available (Ctrl+Alt+F1); greetd owns tty7. Plymouth must quit normally
  # (no --retain-splash): a console left in graphics mode makes the kernel ignore greetd's switch to tty7.
  # Other aurora-* units shipped in rootfs/ are enabled when they have an [Install] section.
  for f in "$ROOTFS_SRC"/usr/lib/systemd/system/aurora-* "$ROOTFS_SRC"/etc/systemd/system/aurora-*; do
    [[ -f "$f" ]] || continue
    u="$(basename "$f")"
    case "$u" in *.service|*.timer|*.socket|*.path) ;; *) continue ;; esac
    [[ "$u" == aurora-apparmor.service ]] && continue
    grep -q '^\[Install\]' "$f" || continue
    in_chroot "$ROOT" systemctl enable "$u" >/dev/null 2>&1 || die "cannot enable $u (rootfs/)"
    log "enabled $u"
  done

  # ufw: deny incoming, allow outgoing, enabled at boot.
  sed -i -e 's/^DEFAULT_INPUT_POLICY=.*/DEFAULT_INPUT_POLICY="DROP"/' \
         -e 's/^DEFAULT_OUTPUT_POLICY=.*/DEFAULT_OUTPUT_POLICY="ACCEPT"/' \
         -e 's/^DEFAULT_FORWARD_POLICY=.*/DEFAULT_FORWARD_POLICY="DROP"/' "$ROOT/etc/default/ufw"
  sed -i 's/^ENABLED=.*/ENABLED=yes/' "$ROOT/etc/ufw/ufw.conf"

  # greetd's system user runs Xorg + Electron for the sign-in screen. Its home (/etc/greetd by
  # default) is not writable, which breaks the per-user services logind starts for it
  # (PipeWire/WirePlumber state): give it /var/lib/aurora-greeter (also created by tmpfiles.d).
  in_chroot "$ROOT" getent passwd _greetd >/dev/null || die "greetd user _greetd does not exist"
  in_chroot "$ROOT" usermod -a -G video,render,input _greetd
  in_chroot "$ROOT" usermod -d /var/lib/aurora-greeter _greetd
  install -d -m 0750 "$ROOT/var/lib/aurora-greeter"
  in_chroot "$ROOT" chown _greetd:_greetd /var/lib/aurora-greeter
}

configure_plymouth() {
  local theme="$ROOT/usr/share/plymouth/themes/aurora" logo="$SHELL_SRC/renderer/assets/aurora-logo.svg"
  [[ -f "$theme/aurora.plymouth" ]] || { warn "no Plymouth theme in rootfs/, keeping the default"; return; }
  [[ -d "$ROOT/usr/share/plymouth/themes/spinner" ]] || die "plymouth-theme-spinner is required for the Selene OS theme"
  # Dialog, entry and keyboard images come from Ubuntu's spinner theme. The logo (watermark) is rendered from
  # the shell's SVG, and the spinner is drawn here: a thin lunar-silver arc turning on a faint track
  # (no ring of dots). Preview: docs/design/plymouth-preview.png.
  local f i a
  for f in "$ROOT"/usr/share/plymouth/themes/spinner/*.png; do
    case "$(basename "$f")" in watermark.png|bgrt-fallback.png|animation-*|throbber-*) continue ;; esac
    cp "$f" "$theme/"
  done
  # shellcheck disable=SC2054  # ImageMagick option values contain commas
  local png_opts=(-depth 8 -define png:exclude-chunks=date,time +set date:create +set date:modify -strip)
  rsvg-convert -w 128 -h 128 "$logo" -o "$theme/watermark.tmp.png"
  convert "$theme/watermark.tmp.png" "${png_opts[@]}" "PNG32:$theme/watermark.png"
  rm -f "$theme/watermark.tmp.png"
  # 36 frames for one turn, drawn at 2x and reduced to 40x40 (a 30 px ring, 2 px stroke).
  for ((i = 0; i < 36; i++)); do
    a=$((i * 10 - 90))
    convert -size 80x80 xc:none -fill none -strokewidth 4 \
      -stroke 'rgba(201,211,230,0.18)' -draw 'circle 40,40 40,10' \
      -stroke '#c9d3e6' -draw "stroke-linecap round arc 10,10 70,70 $a,$((a + 80))" \
      -resize 40x40 "${png_opts[@]}" "PNG32:$theme/$(printf 'throbber-%04d.png' $((i + 1)))"
  done
  in_chroot "$ROOT" update-alternatives --quiet --install /usr/share/plymouth/themes/default.plymouth \
    default.plymouth /usr/share/plymouth/themes/aurora/aurora.plymouth 300
  in_chroot "$ROOT" update-alternatives --quiet --set default.plymouth /usr/share/plymouth/themes/aurora/aurora.plymouth
}

validate_system() {
  log "validating the image"
  # Electron must find every shared library it links against.
  local nf
  nf="$(in_chroot "$ROOT" /bin/sh -c 'ldd /opt/aurora/electron/electron; ldd /opt/aurora/electron/libEGL.so 2>/dev/null; ldd /opt/aurora/electron/libGLESv2.so 2>/dev/null' | grep 'not found' | sort -u || true)"
  [[ -z "$nf" ]] || die "Electron is missing shared libraries in the image:
$nf"
  [[ -u "$ROOT/opt/aurora/electron/chrome-sandbox" ]] || die "chrome-sandbox is not setuid"
  [[ "$(stat -c '%u:%g %a' "$ROOT/opt/aurora/electron/chrome-sandbox")" == "0:0 4755" ]] \
    || die "chrome-sandbox must be root:root 4755"
  # AppArmor profile must parse (and be loaded in the live session by aurora-apparmor.service).
  [[ -f "$ROOT/etc/apparmor.d/aurora-shell" ]] || die "AppArmor profile /etc/apparmor.d/aurora-shell is missing (rootfs/)"
  local out r
  out="$(in_chroot "$ROOT" apparmor_parser --skip-kernel-load --skip-cache -Q /etc/apparmor.d/aurora-shell 2>&1)" \
    || die "AppArmor profile /etc/apparmor.d/aurora-shell does not parse:
$out"
  grep -q '^profile aurora-shell /opt/aurora/electron/electron ' "$ROOT/etc/apparmor.d/aurora-shell" \
    || die "the AppArmor profile must attach to /opt/aurora/electron/electron"
  [[ -f "$ROOT/usr/lib/systemd/system/aurora-apparmor.service" ]] || die "aurora-apparmor.service is missing (rootfs/)"
  # Every unit shipped in rootfs/ must pass systemd's own checks.
  local units=()
  for r in "$ROOT"/usr/lib/systemd/system/aurora-* "$ROOT"/etc/systemd/system/aurora-*; do
    [[ -f "$r" ]] && units+=("${r#"$ROOT"}")
  done
  if ((${#units[@]})); then
    out="$(in_chroot "$ROOT" systemd-analyze verify "${units[@]}" 2>&1)" || die "systemd-analyze verify failed:
$out"
  fi
  # polkit rules are JavaScript: syntax-check them with node on the host.
  local node="$NODE_BIN/node"
  [[ -x "$node" ]] || node="$(command -v node)"
  for r in "$ROOT"/etc/polkit-1/rules.d/*aurora*.rules; do
    [[ -f "$r" ]] || continue
    "$node" -e 'new Function(require("fs").readFileSync(process.argv[1], "utf8"))' "$r" \
      || die "polkit rules syntax error: $r"
  done
  # Session entry points and helpers: present, executable, valid shell syntax.
  for r in /usr/bin/aurora-shell /usr/bin/aurora-session /usr/lib/aurora/aurora-greeter /usr/lib/aurora/aurora-xsession \
           /usr/lib/aurora/aurora-xstart /usr/lib/aurora/aurora-xgreeter; do
    [[ -x "$ROOT$r" ]] || die "$r is missing or not executable (rootfs/)"
  done
  for r in "$ROOT"/usr/bin/aurora-* "$ROOT"/usr/lib/aurora/aurora-* "$ROOT"/usr/lib/aurora/helpers/* \
           "$ROOT"/usr/lib/aurora/autoinstall/aurora-*; do
    [[ -f "$r" ]] || continue
    case "$(head -n1 "$r")" in
      '#!/bin/sh'*|'#!/usr/bin/sh'*|'# shellcheck shell=sh'*) in_chroot "$ROOT" /bin/sh -n "${r#"$ROOT"}" || die "shell syntax error in ${r#"$ROOT"}" ;;
      '#!/bin/bash'*|'#!/usr/bin/bash'*|'#!/usr/bin/env bash'*) in_chroot "$ROOT" /bin/bash -n "${r#"$ROOT"}" || die "bash syntax error in ${r#"$ROOT"}" ;;
      '#!/usr/bin/python3'*|'#!/usr/bin/env python3'*)
        in_chroot "$ROOT" python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "${r#"$ROOT"}" \
          || die "python syntax error in ${r#"$ROOT"}" ;;
    esac
  done
  # greetd: graphical greeter as _greetd, live user signed in automatically.
  local gc="$ROOT/etc/greetd/config.toml"
  grep -q '^user = "_greetd"' "$gc" || die "/etc/greetd/config.toml must run the greeter as _greetd"
  grep -q '^command = "/usr/lib/aurora/aurora-greeter"' "$gc" || die "/etc/greetd/config.toml must start /usr/lib/aurora/aurora-greeter"
  awk '/^\[initial_session\]/ {f=1; next} /^\[/ {f=0} f && /^user = / {print}' "$gc" | grep -q "\"$LIVE_USER\"" \
    || die "/etc/greetd/config.toml: [initial_session] must sign in the live user '$LIVE_USER'"
  # Units that must start at boot.
  for r in greetd.service NetworkManager.service ufw.service aurora-apparmor.service; do
    [[ "$(in_chroot "$ROOT" systemctl is-enabled "$r" 2>/dev/null)" == enabled ]] || die "$r is not enabled"
  done
  [[ "$(in_chroot "$ROOT" systemctl get-default)" == graphical.target ]] || die "default target is not graphical.target"
  [[ -f "$ROOT/opt/aurora/shell/renderer/shell.html" ]] || die "shell.html missing from /opt/aurora/shell"
  if [[ ! -f "$ROOT/opt/aurora/shell/renderer/greeter.html" ]]; then
    warn "renderer/greeter.html does not exist yet: the live session autologins, but signing out will show an empty greeter"
  fi
  ok "image checks passed"
}

clamp_mtimes() { # dir
  find "$1" -xdev -newermt "@$SOURCE_DATE_EPOCH" -print0 2>/dev/null | xargs -0r touch -h -d "@$SOURCE_DATE_EPOCH" 2>/dev/null || true
}

cleanup_image() {
  log "cleaning the image"
  # Packages shipped in the image: the Store never removes them (aurora-admin store-remove).
  mkdir -p "$ROOT/usr/share/aurora/store"
  in_chroot "$ROOT" dpkg-query -W --showformat='${Package}\n' | LC_ALL=C sort -u >"$ROOT/usr/share/aurora/store/base-packages.txt"
  chmod 644 "$ROOT/usr/share/aurora/store/base-packages.txt"
  write_final_sources "$ROOT"
  apt_net_off "$ROOT"
  rm -rf "$ROOT"/var/lib/apt/lists/* "$ROOT"/var/cache/apt/*.bin "$ROOT"/var/cache/apt/archives/*.deb
  mkdir -p "$ROOT/var/lib/apt/lists/partial"
  rm -f "$ROOT"/var/cache/debconf/*-old "$ROOT"/var/lib/dpkg/*-old
  rm -rf "$ROOT"/tmp/* "$ROOT"/var/tmp/* "$ROOT"/root/.bash_history "$ROOT"/root/.cache "$ROOT"/root/.npm
  find "$ROOT/var/log" -type f \( -name '*.gz' -o -name '*.[0-9]' -o -name '*.old' \) -delete
  find "$ROOT/var/log" -type f -exec truncate -s 0 {} +
  rm -f "$ROOT/var/cache/ldconfig/aux-cache" "$ROOT/var/lib/systemd/random-seed" "$ROOT/var/lib/dbus/machine-id"
  : >"$ROOT/etc/machine-id"
  ln -sf /etc/machine-id "$ROOT/var/lib/dbus/machine-id"
  # Documentation/translations installed by debootstrap before the dpkg excludes existed.
  find "$ROOT/usr/share/doc" -mindepth 1 ! -type d ! -name copyright -delete 2>/dev/null || true
  find "$ROOT/usr/share/doc" -mindepth 1 -type d -empty -delete 2>/dev/null || true
  rm -rf "$ROOT"/usr/share/info/* "$ROOT"/usr/share/lintian/*
  if [[ -x "$ROOT/usr/bin/man" ]]; then
    # man-db is part of the image (Terminal): English and French manual pages only.
    find "$ROOT/usr/share/man" -mindepth 1 -maxdepth 1 ! -name 'man*' ! -name 'fr*' -exec rm -rf {} + 2>/dev/null || true
  else
    rm -rf "$ROOT"/usr/share/man/*
  fi
  find "$ROOT/usr/share/locale" -mindepth 1 -maxdepth 1 -type d ! -name 'en*' ! -name 'fr*' -exec rm -rf {} + 2>/dev/null || true
}

finalize_resolv_conf() {
  rm -f "$ROOT/etc/resolv.conf.aurora-build" "$ROOT/etc/resolv.conf"
  if [[ -e "$ROOT/usr/lib/systemd/resolv.conf" ]]; then
    # systemd-resolved owns /etc/resolv.conf on the running system.
    ln -s ../run/systemd/resolve/stub-resolv.conf "$ROOT/etc/resolv.conf"
  else
    : >"$ROOT/etc/resolv.conf"   # NetworkManager fills it in
  fi
}

# Final hygiene checks on the tree that gets squashed: nothing from the build host leaks in.
assert_clean_image() {
  log "checking the image for build leftovers"
  local f bad=()
  for f in /etc/apt/aurora-build-ca.crt /etc/apt/apt.conf.d/99aurora-build /usr/sbin/policy-rc.d \
           /etc/resolv.conf.aurora-build /root/.npm /root/.cache; do
    [[ -e "$ROOT$f" || -L "$ROOT$f" ]] && bad+=("$f exists")
  done
  has_text aurora-build "$(chroot "$ROOT" dpkg-divert --list 2>/dev/null)" && bad+=("build-time dpkg diversion left")
  # Proxy settings of the build host.
  local p
  for p in "$BUILD_HTTPS_PROXY" "$BUILD_HTTP_PROXY"; do
    [[ -n "$p" ]] || continue
    if grep -rIlsF -- "$p" "$ROOT/etc" "$ROOT/root" "$ROOT/opt/aurora" "$ROOT/var/lib/apt" "$ROOT/home" >/dev/null 2>&1; then
      bad+=("build proxy $p referenced in: $(grep -rIlsF -- "$p" "$ROOT/etc" "$ROOT/root" "$ROOT/opt/aurora" "$ROOT/var/lib/apt" "$ROOT/home" | sed "s|^$ROOT||" | head -n5 | tr '\n' ' ')")
    fi
  done
  grep -qis 'proxy' "$ROOT/etc/environment" && bad+=("/etc/environment mentions a proxy")
  # The build CA bundle (e.g. a TLS-intercepting proxy's CA) must not be shipped.
  if [[ -n "$BUILD_CA_BUNDLE" && "$(readlink -f "$BUILD_CA_BUNDLE")" != /etc/ssl/certs/ca-certificates.crt ]]; then
    local sum size
    sum="$(sha256sum <"$BUILD_CA_BUNDLE" | cut -d' ' -f1)"; size="$(stat -Lc %s "$BUILD_CA_BUNDLE")"
    while IFS= read -r -d '' f; do
      [[ "$(sha256sum <"$f" | cut -d' ' -f1)" == "$sum" ]] && bad+=("copy of the build CA bundle: ${f#"$ROOT"}")
    done < <(find "$ROOT/etc" "$ROOT/usr/local" "$ROOT/usr/share/ca-certificates" "$ROOT/opt/aurora" -xdev -type f -size "${size}c" -print0 2>/dev/null)
  fi
  # Per-machine identity.
  [[ -s "$ROOT/etc/machine-id" ]] && bad+=("/etc/machine-id is not empty")
  [[ "$(readlink "$ROOT/var/lib/dbus/machine-id")" == /etc/machine-id ]] || bad+=("/var/lib/dbus/machine-id is not a symlink to /etc/machine-id")
  compgen -G "$ROOT/etc/ssh/ssh_host_*" >/dev/null && bad+=("SSH host keys present")
  [[ -e "$ROOT/var/lib/systemd/random-seed" ]] && bad+=("systemd random seed present")
  # Permissions.
  local ww
  ww="$(find "$ROOT/opt/aurora" -xdev \( -type f -o -type d \) -perm -0002 | sed "s|^$ROOT||" | head -n5)"
  [[ -z "$ww" ]] || bad+=("world-writable files under /opt/aurora: $ww")
  ww="$(find "$ROOT/opt/aurora" -xdev ! -user 0 | sed "s|^$ROOT||" | head -n5)"
  [[ -z "$ww" ]] || bad+=("files not owned by root under /opt/aurora: $ww")
  ww="$(find "$ROOT/opt/aurora" -xdev -type f -perm /6000 | sed "s|^$ROOT||")"
  [[ "$ww" == /opt/aurora/electron/chrome-sandbox ]] || bad+=("unexpected setuid/setgid set under /opt/aurora: $ww")
  ww="$(find "$ROOT/usr/lib/aurora" "$ROOT/opt/aurora/shell/main" "$ROOT/opt/aurora/shell/renderer" "$ROOT/etc" -xdev \
         \( -name __pycache__ -o -name '*.pyc' \) 2>/dev/null | sed "s|^$ROOT||" | head -n5)"
  [[ -z "$ww" ]] || bad+=("development leftovers: $ww")
  # Final package sources.
  grep -qF "URIs: $FINAL_MIRROR" "$ROOT/etc/apt/sources.list.d/ubuntu.sources" || bad+=("ubuntu.sources does not point to $FINAL_MIRROR")
  if ((${#bad[@]})); then
    printf '  - %s\n' "${bad[@]}" >&2
    die "the image is not clean (see above)"
  fi
  ok "image is clean (no build proxy/CA, no machine-id, no host keys, sane /opt/aurora permissions)"
}

write_manifests() {
  local m="$WORK/manifest"
  rm -rf "$m"; mkdir -p "$m"
  in_chroot "$ROOT" dpkg-query -W --showformat='${binary:Package}\t${Version}\n' | LC_ALL=C sort >"$m/filesystem.manifest"
  # Live-only packages: casper and whatever only it pulled in. The installer purges these.
  local sim
  sim="$(in_chroot "$ROOT" apt-get -s -o Debug::NoLocking=1 purge --autoremove casper 2>/dev/null)"
  { echo casper; awk '/^Purg / {print $2}' <<<"$sim"; } | sed 's/:amd64$//' | LC_ALL=C sort -u >"$m/filesystem.manifest-remove"
  log "live-only packages (filesystem.manifest-remove): $(tr '\n' ' ' <"$m/filesystem.manifest-remove")"
}

stage_system() {
  stage system
  [[ -f "$PKG_LAYER.key" ]] || die "package layer missing — run the packages stage first"
  umount_under "$ROOT"
  umount_under "$WORK/layers"
  rm -rf "$SYS_UPPER"
  mount_system_overlay
  chroot_mount "$ROOT"
  undivert_initramfs "$ROOT"

  install_selene_debs
  write_os_identity
  configure_locale_time
  configure_skel
  configure_casper
  configure_services
  configure_plymouth
  validate_system

  log "generating the initramfs"
  cat >"$ROOT/etc/initramfs-tools/conf.d/aurora.conf" <<'EOF'
# Selene OS: zstd is fast to decompress; keep every storage/graphics driver for live boots.
COMPRESS=zstd
MODULES=most
EOF
  local kver
  kver="$(basename "$(find "$ROOT/usr/lib/modules" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n1)")"
  [[ -n "$kver" && -f "$ROOT/boot/vmlinuz-$kver" ]] || die "no kernel found in the image"
  rm -f "$ROOT"/boot/initrd.img-*
  run_bg in_chroot "$ROOT" update-initramfs -c -k "$kver" || die "update-initramfs failed"
  [[ -s "$ROOT/boot/initrd.img-$kver" ]] || die "initramfs generation failed"
  has_text "scripts/casper-bottom" "$(in_chroot "$ROOT" lsinitramfs "/boot/initrd.img-$kver")" \
    || die "the initramfs does not contain casper"
  echo "$kver" >"$WORK/kernel-version"
  log "kernel $kver, initrd $(du -h "$ROOT/boot/initrd.img-$kver" | cut -f1)"

  write_manifests
  cleanup_image
  chroot_umount "$ROOT"
  finalize_resolv_conf
  assert_clean_image
  # Reproducible timestamps, then font caches that match them.
  clamp_mtimes "$ROOT"
  chroot "$ROOT" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin fc-cache -s -f >/dev/null 2>&1 || warn "fc-cache failed"
  clamp_mtimes "$ROOT"
  stage_done system
}

# ---------------------------------------------------------------------------------------
# stage: squashfs
# ---------------------------------------------------------------------------------------
ISO_TREE="$WORK/iso"

stage_squashfs() {
  stage squashfs
  mountpoint -q "$ROOT" || mount_system_overlay
  rm -rf "$ISO_TREE"; mkdir -p "$ISO_TREE/casper"
  [[ -s "$WORK/manifest/filesystem.manifest" ]] || die "manifests missing — run the system stage first"
  cp "$WORK/manifest/filesystem.manifest" "$WORK/manifest/filesystem.manifest-remove" "$ISO_TREE/casper/"
  du -sx --block-size=1 "$ROOT" | cut -f1 >"$ISO_TREE/casper/filesystem.size"

  log "mksquashfs ($SQUASHFS_COMP level $SQUASHFS_LEVEL, block $SQUASHFS_BLOCK) — this takes a while"
  local comp=(-comp "$SQUASHFS_COMP")
  case "$SQUASHFS_COMP" in
    zstd) comp+=(-Xcompression-level "$SQUASHFS_LEVEL") ;;
    xz) comp+=(-Xbcj x86) ;;
  esac
  # SOURCE_DATE_EPOCH is unset for mksquashfs on purpose: it would force *every* timestamp to
  # that value; the tree's mtimes are already clamped (keeping caches such as fontconfig valid).
  run_bg env -u SOURCE_DATE_EPOCH mksquashfs "$ROOT" "$ISO_TREE/casper/filesystem.squashfs" \
    -noappend -no-progress -quiet "${comp[@]}" -b "$SQUASHFS_BLOCK" \
    -mkfs-time "$SOURCE_DATE_EPOCH" -root-time "$SOURCE_DATE_EPOCH" \
    -xattrs-exclude '^system\.posix_acl_' \
    -wildcards -e 'proc/*' 'sys/*' 'dev/*' 'run/*' 'tmp/*' 'var/tmp/*' 'boot/efi/*' \
    || die "mksquashfs failed"
  log "filesystem.squashfs: $(du -h "$ISO_TREE/casper/filesystem.squashfs" | cut -f1) (uncompressed $(( $(cat "$ISO_TREE/casper/filesystem.size") / 1024 / 1024 )) MiB)"
  local kver; kver="$(cat "$WORK/kernel-version")"
  cp "$ROOT/boot/vmlinuz-$kver" "$ISO_TREE/casper/vmlinuz"
  cp "$ROOT/boot/initrd.img-$kver" "$ISO_TREE/casper/initrd"
  umount_under "$ROOT"
  stage_done squashfs
}

# ---------------------------------------------------------------------------------------
# stage: iso
# ---------------------------------------------------------------------------------------
font_file() { # pattern... -> first matching font in the package layer
  local p f
  for p in "$@"; do
    f="$(find "$PKG_LAYER/usr/share/fonts" -iname "$p" 2>/dev/null | sort | sed -n 1p)"
    [[ -n "$f" ]] && { echo "$f"; return 0; }
  done
  return 1
}

make_grub_theme() {
  local t="$ISO_TREE/boot/grub/themes/aurora" logo="$SHELL_SRC/renderer/assets/aurora-logo.svg"
  local wall="$SHELL_SRC/renderer/assets/wallpapers/nocturne-dark.jpg"
  local tmp="$WORK/grub-theme"
  [[ -f "$wall" ]] || die "GRUB theme: missing wallpaper $wall"
  rm -rf "$t" "$tmp"; mkdir -p "$t" "$tmp"
  local regular bold
  regular="$(font_file 'Inter-Regular.*' 'Inter*.ttf' 'Inter*.otf' 'DejaVuSans.ttf')" || die "no font for the GRUB theme"
  bold="$(font_file 'Inter-SemiBold.*' 'Inter-Bold.*' 'DejaVuSans-Bold.ttf')" || bold="$regular"
  # GRUB bitmap fonts (Latin + punctuation + arrows: enough for English and French).
  # grub-mkfont names them "<-n> <style> <size>", e.g. "Aurora Regular Regular 20": theme.txt must use
  # exactly these names, or GRUB silently falls back to the first loaded font.
  # (grub-mkfont prints harmless "unsupported font feature" notes for OpenType fonts.)
  local range="0x20-0x7E,0xA0-0x17F,0x2013-0x2026,0x2190-0x2193,0x25B2-0x25BC" mk="$WORK/grub-mkfont.log"
  {
    grub-mkfont -s 16 -r "$range" -n "Aurora Regular" -o "$t/aurora-16.pf2" "$regular" &&
    grub-mkfont -s 20 -r "$range" -n "Aurora Regular" -o "$t/aurora-20.pf2" "$regular" &&
    grub-mkfont -s 22 -r "$range" -n "Aurora Bold"    -o "$t/aurora-bold-22.pf2" "$bold" &&
    grub-mkfont -s 36 -r "$range" -n "Aurora Bold"    -o "$t/aurora-bold-36.pf2" "$bold"
  } >"$mk" 2>&1 || { tail -n 20 "$mk" >&2; die "grub-mkfont failed"; }

  # shellcheck disable=SC2054  # ImageMagick option values contain commas
  # GRUB's PNG reader only handles 8-bit RGB/RGBA (no 16-bit, palette or grey+alpha images): ImageMagick
  # writes gradients as 16-bit and tiny shapes as palette/grey PNGs unless told otherwise (PNG24:/PNG32:).
  local png_opts=(-depth 8 -define png:exclude-chunks=date,time +set date:create +set date:modify -strip)
  # Nocturne look (docs/design/SYSTEM.md, cold ambiance): the night-sea wallpaper, darkened on the left where
  # the logo and the menu sit, so the moon stays visible on the right. Logo, name and menu are theme
  # components (not drawn into the image), so they keep their place at every resolution.
  convert "$wall" -resize '1920x1080^' -gravity center -extent 1920x1080 \
    \( -size 1080x1250 gradient:'rgba(7,10,18,0.80)-rgba(7,10,18,0)' -rotate -90 \) \
      -gravity west -compose over -composite \
    \( -size 1920x260 gradient:'rgba(7,10,18,0)-rgba(7,10,18,0.55)' \) -gravity south -compose over -composite \
    "${png_opts[@]}" "PNG24:$t/background.png"
  rsvg-convert -w 72 -h 72 "$logo" -o "$tmp/logo.png"
  convert "$tmp/logo.png" "${png_opts[@]}" "PNG32:$t/logo.png"
  # 9-slice pieces (corners, edges, centre) cut from a small rounded square.
  slice9() { # src size prefix
    local src="$1" n="$2" p="$3" spec
    for spec in "nw ${n}x${n}+0+0" "n 1x${n}+${n}+0" "ne ${n}x${n}+$((n+1))+0" "w ${n}x1+0+${n}" "c 1x1+${n}+${n}" \
                "e ${n}x1+$((n+1))+${n}" "sw ${n}x${n}+0+$((n+1))" "s 1x${n}+${n}+$((n+1))" "se ${n}x${n}+$((n+1))+$((n+1))"; do
      convert "$src" -crop "${spec#* }" +repage "${png_opts[@]}" "PNG32:$t/${p}_${spec%% *}.png"
    done
  }
  # Selected entry: a lunar-silver pill (accent "silver", dark text on it: 12:1).
  local s=9
  convert -size $((s*2+1))x$((s*2+1)) xc:none -fill '#c9d3e6' -draw "roundrectangle 0,0 $((s*2)),$((s*2)) $s,$s" "$tmp/hl.png"
  slice9 "$tmp/hl.png" "$s" select
  # Menu panel: the night surface (#0e131f) at 88 % with a faint silver hairline, like the shell's panels.
  local m=14
  convert -size $((m*2+1))x$((m*2+1)) xc:none -fill '#0e131fe0' -stroke '#cdd8ee30' -strokewidth 1 \
    -draw "roundrectangle 0.5,0.5 $((m*2)).5,$((m*2)).5 $m,$m" "$tmp/panel.png"
  slice9 "$tmp/panel.png" "$m" menu
  unset -f slice9

  # Colours are the cold ambiance's: text #e6eaf2, text-2 #a9b2c5, text-3 #959fb4 (>= 7:1 on the panel).
  cat >"$t/theme.txt" <<EOF
# Selene OS GRUB theme (generated by iso/build.sh make_grub_theme; preview: docs/design/grub-preview.png)
title-text: ""
desktop-image: "background.png"
desktop-image-scale-method: "fitheight"
desktop-image-h-align: "center"
desktop-image-v-align: "center"
desktop-color: "#070a12"
terminal-font: "Aurora Regular Regular 16"
terminal-box: "menu_*.png"
terminal-left: "9%"
terminal-top: "10%"
terminal-width: "82%"
terminal-height: "80%"

+ image {
  left = 9%
  top = 50%-330
  width = 72
  height = 72
  file = "logo.png"
}

+ label {
  left = 9%+92
  top = 50%-324
  width = 600
  height = 44
  align = "left"
  color = "#e6eaf2"
  font = "Aurora Bold Regular 36"
  text = "${OS_NAME}"
}

+ label {
  left = 9%+94
  top = 50%-278
  width = 400
  height = 22
  align = "left"
  color = "#a9b2c5"
  font = "Aurora Regular Regular 16"
  text = "Version ${ISO_VERSION}"
}

+ boot_menu {
  left = 9%
  top = 50%-212
  width = 640
  height = 262
  menu_pixmap_style = "menu_*.png"
  item_font = "Aurora Regular Regular 20"
  item_color = "#e6eaf2"
  selected_item_font = "Aurora Bold Regular 22"
  selected_item_color = "#101624"
  selected_item_pixmap_style = "select_*.png"
  item_height = 42
  item_padding = 16
  item_spacing = 6
  icon_width = 0
  icon_height = 0
  item_icon_space = 0
  scrollbar = false
}

# Two countdown labels (GRUB fills one %d per label): English, then French.
+ label {
  id = "__timeout__"
  left = 9%+18
  top = 50%+72
  width = 160
  height = 22
  align = "left"
  color = "#a9b2c5"
  font = "Aurora Regular Regular 16"
  text = "Starting in %d s"
}

+ label {
  id = "__timeout__"
  left = 9%+156
  top = 50%+72
  width = 320
  height = 22
  align = "left"
  color = "#a9b2c5"
  font = "Aurora Regular Regular 16"
  text = "·   Démarrage dans %d s"
}

+ label {
  left = 9%
  top = 100%-64
  width = 82%
  height = 22
  align = "left"
  color = "#959fb4"
  font = "Aurora Regular Regular 16"
  text = "↑ ↓ choose / choisir   ·   Enter / Entrée: start / démarrer   ·   e: edit / modifier"
}
EOF
}

write_grub_cfg() {
  local common="boot=casper"
  cat >"$ISO_TREE/boot/grub/grub.cfg" <<EOF
# Selene OS $ISO_VERSION live media ($BUILD_ID) — generated by iso/build.sh
set default=0
set timeout=8
set timeout_style=menu

insmod all_video
insmod gfxterm
insmod gfxmenu
insmod png
insmod font
insmod part_gpt
insmod part_msdos
insmod iso9660
insmod regexp

set gfxmode=1920x1080,1600x900,1280x800,1024x768,auto
set gfxpayload=keep
set theme_dir=\$prefix/themes/aurora
if loadfont \$theme_dir/aurora-16.pf2 ; then
  loadfont \$theme_dir/aurora-20.pf2
  loadfont \$theme_dir/aurora-bold-22.pf2
  loadfont \$theme_dir/aurora-bold-36.pf2
  terminal_output gfxterm
  set theme=\$theme_dir/theme.txt
  export theme
fi
set menu_color_normal=light-gray/black
set menu_color_highlight=white/blue

menuentry "$OS_NAME (English)" --class aurora --id aurora-en {
  set gfxpayload=keep
  linux /casper/vmlinuz $common quiet splash locale=en_US.UTF-8 keyboard-configuration/layoutcode=us ---
  initrd /casper/initrd
}

menuentry "$OS_NAME (Français)" --class aurora --id aurora-fr {
  set gfxpayload=keep
  linux /casper/vmlinuz $common quiet splash locale=fr_FR.UTF-8 keyboard-configuration/layoutcode=fr ---
  initrd /casper/initrd
}

menuentry "Safe graphics / Mode graphique sûr" --class aurora --id aurora-safe {
  set gfxpayload=keep
  linux /casper/vmlinuz $common nomodeset quiet splash locale=en_US.UTF-8 ---
  initrd /casper/initrd
}

menuentry "Hard disk / Disque dur" --class disk --id hdd {
  if [ "\$grub_platform" = "efi" ]; then
    # Chainload an installed system's boot loader; fall back to the firmware boot order.
    for f in /EFI/aurora/shimx64.efi /EFI/aurora/grubx64.efi /EFI/ubuntu/shimx64.efi /EFI/ubuntu/grubx64.efi /EFI/Microsoft/Boot/bootmgfw.efi; do
      if search --no-floppy --file --set=esp \$f; then
        chainloader (\$esp)\$f
        boot
      fi
    done
    exit 1
  else
    # The disk this menu was loaded from is the ISO itself (CD or USB stick): skip it.
    regexp --set=1:isodisk '^\(?([a-z]+[0-9]+)' "\$root"
    if [ "\$isodisk" = "hd0" ]; then set target=hd1; else set target=hd0; fi
    insmod chain
    set root=(\$target)
    chainloader +1
    boot
  fi
}

submenu "Advanced options / Options avancées" --class advanced {
  menuentry "Debug mode / Mode débogage" --id aurora-debug {
    linux /casper/vmlinuz $common locale=en_US.UTF-8 console=tty1 console=ttyS0,115200n8 systemd.journald.forward_to_console=1 systemd.show_status=1 aurora.debug ---
    initrd /casper/initrd
  }
  menuentry "Copy to RAM / Copier en mémoire" --id aurora-toram {
    linux /casper/vmlinuz $common toram quiet splash locale=en_US.UTF-8 ---
    initrd /casper/initrd
  }
  menuentry "Check the disc / Vérifier le disque" --id check {
    linux /casper/vmlinuz $common integrity-check quiet splash locale=en_US.UTF-8 ---
    initrd /casper/initrd
  }
  if [ "\$grub_platform" = "efi" ]; then
    menuentry "UEFI settings / Paramètres UEFI" --id uefi-firmware {
      fwsetup
    }
  fi
  menuentry "Restart / Redémarrer" --id reboot {
    reboot
  }
  menuentry "Shut down / Arrêter" --id halt {
    halt
  }
}
EOF
}

# ---- Secure Boot EFI boot image -------------------------------------------------------------
# grub-mkrescue builds the BIOS side (eltorito.img, hybrid MBR) and a FAT EFI image with its own,
# unsigned GRUB. Its xorriso call goes through a small wrapper that swaps that EFI image (and the
# ISO's /efi/boot/) for Ubuntu's signed boot chain, taken from the image's own packages:
#   EFI/BOOT/BOOTX64.EFI = shim-signed (Microsoft-signed shim), grubx64.efi = grub-efi-amd64-signed's
#   CD GRUB (gcdx64.efi.signed, Canonical-signed), mmx64.efi = MokManager.
# The signed GRUB finds /.disk/info and reads /boot/grub/grub.cfg; grub.cfg stubs next to it (and in
# EFI/ubuntu, its built-in prefix) do the same. Under Secure Boot GRUB only uses its built-in modules
# and verifies the kernel through shim; the theme may fall back to the text menu.
layer_file() { # path-in-image -> the file in the package layer (symlinks resolved inside the layer)
  local p="$1" t i
  for i in 1 2 3 4 5 6; do
    [[ -L "$PKG_LAYER$p" ]] || break
    t="$(readlink "$PKG_LAYER$p")"
    [[ "$t" == /* ]] || t="$(dirname "$p")/$t"
    p="$t"
  done
  [[ -f "$PKG_LAYER$p" ]] || die "$p is missing from the package layer (shim-signed / grub-efi-amd64-signed in base.list?)"
  echo "$PKG_LAYER$p"
}

make_secureboot_efi() { # dir -> $dir/efi.img, $dir/boot/ (the ISO's /efi/boot/), $dir/xorriso (wrapper)
  local d="$1" f size_kb
  [[ -n "$d" ]] || die "make_secureboot_efi: no directory"
  rm -rf "$d"; mkdir -p "$d/boot"
  cp "$(layer_file /usr/lib/shim/shimx64.efi.signed)" "$d/boot/bootx64.efi"
  cp "$(layer_file /usr/lib/grub/x86_64-efi-signed/gcdx64.efi.signed)" "$d/boot/grubx64.efi"
  cp "$(layer_file /usr/lib/shim/mmx64.efi)" "$d/boot/mmx64.efi"
  printf '%s\n' "# Selene OS live media: the signed GRUB reads the menu from the ISO (iso/build.sh)." \
    'search --no-floppy --set=root --file /.disk/aurora-build-id' \
    'set prefix=($root)/boot/grub' \
    'configfile $prefix/grub.cfg' >"$d/boot/grub.cfg"
  find "$d/boot" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
  size_kb=$(( $(du -sk --apparent-size "$d/boot" | cut -f1) + 1024 ))
  mkfs.vfat -C -n SELENE_EFI -i "$(printf '%08x' $(( SOURCE_DATE_EPOCH & 0xffffffff )))" "$d/efi.img" "$size_kb" >/dev/null \
    || die "mkfs.vfat failed for the EFI image"
  mmd -i "$d/efi.img" ::/EFI ::/EFI/BOOT ::/EFI/ubuntu || die "mmd failed for the EFI image"
  for f in bootx64.efi grubx64.efi mmx64.efi grub.cfg; do
    mcopy -m -i "$d/efi.img" "$d/boot/$f" "::/EFI/BOOT/$f" || die "mcopy $f failed"
  done
  mcopy -m -i "$d/efi.img" "$d/boot/grub.cfg" ::/EFI/ubuntu/grub.cfg || die "mcopy grub.cfg failed"
  # Wrapper used as grub-mkrescue --xorriso: replaces grub-mkrescue's EFI image, then runs xorriso.
  printf '%s\n' '#!/bin/bash' \
    '# Selene OS (iso/build.sh): swap grub-mkrescue'"'"'s EFI image for the signed one in $AURORA_SB_DIR.' \
    'set -eu' \
    'prev="" img="" done=0' \
    'for a in "$@"; do [[ "$prev" == --efi-boot ]] && img="$a"; prev="$a"; done' \
    'if [[ -n "$img" ]]; then' \
    '  for a in "$@"; do' \
    '    [[ -d "$a" && -f "$a/$img" && -d "$a/efi" ]] || continue' \
    '    cp "$AURORA_SB_DIR/efi.img" "$a/$img"' \
    '    rm -rf "${a:?}/efi"; mkdir -p "$a/efi/boot"' \
    '    cp "$AURORA_SB_DIR"/boot/* "$a/efi/boot/"' \
    '    done=1; break' \
    '  done' \
    '  [[ "$done" == 1 ]] || { echo "aurora xorriso wrapper: grub-mkrescue EFI image not found" >&2; exit 1; }' \
    'fi' \
    'exec xorriso "$@"' >"$d/xorriso"
  chmod 0755 "$d/xorriso"
}

stage_iso() {
  stage iso
  [[ -f "$ISO_TREE/casper/filesystem.squashfs" ]] || die "no squashfs — run the squashfs stage first"
  mkdir -p "$ISO_TREE/.disk" "$ISO_TREE/boot/grub"
  printf '%s %s "%s" - Release %s (%s)\n' "$OS_NAME" "$ISO_VERSION" "$SUITE" "$ARCH" "$BUILD_DATE" >"$ISO_TREE/.disk/info"
  echo "$BUILD_ID" >"$ISO_TREE/.disk/aurora-build-id"
  make_grub_theme
  write_grub_cfg
  log "computing md5sum.txt"
  (
    cd "$ISO_TREE"
    find . -type f ! -name md5sum.txt ! -path './boot/grub/*' -print0 | LC_ALL=C sort -z | xargs -0 md5sum >md5sum.txt
  )
  find "$ISO_TREE" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
  log "creating hybrid BIOS+UEFI ISO with grub-mkrescue"
  local tmp_iso="$ISO_PATH.part"
  rm -f "$tmp_iso"
  make_secureboot_efi "$WORK/secureboot"
  log "EFI boot image: signed shim + GRUB for Secure Boot ($(du -h --apparent-size "$WORK/secureboot/efi.img" | cut -f1))"
  AURORA_SB_DIR="$WORK/secureboot" grub-mkrescue --xorriso="$WORK/secureboot/xorriso" \
      --output="$tmp_iso" --themes= --locales= --fonts=unicode \
      --product-name="$OS_NAME" --product-version="$ISO_VERSION" \
      "$ISO_TREE" -- -volid "$ISO_VOLID" -joliet on >"$WORK/grub-mkrescue.log" 2>&1 \
    || { tail -n 30 "$WORK/grub-mkrescue.log" >&2; die "grub-mkrescue failed"; }
  mv "$tmp_iso" "$ISO_PATH"
  (cd "$OUT" && sha256sum "$(basename "$ISO_PATH")" >"$(basename "$ISO_PATH").sha256")
  cp "$ISO_TREE/casper/filesystem.manifest" "$OUT/$(basename "$ISO_PATH" .iso).manifest"
  # Hand the results to the user who started the build (sudo/make iso, or make docker-iso).
  local owner="${AURORA_OUT_OWNER:-}"
  [[ -z "$owner" && -n "${SUDO_UID:-}" && "${SUDO_UID}" != 0 ]] && owner="$SUDO_UID:${SUDO_GID:-$SUDO_UID}"
  if [[ "$owner" =~ ^[0-9]+:[0-9]+$ ]]; then
    chown "$owner" "$OUT" "$ISO_PATH" "$ISO_PATH.sha256" "$OUT/$(basename "$ISO_PATH" .iso).manifest" || true
    # make run (as the user) keeps the VM disk and state in work/qemu/, but work/ belongs to root.
    if [[ ! -e "$WORK/qemu" || "$(stat -c %u "$WORK/qemu")" == 0 ]]; then
      mkdir -p "$WORK/qemu" && chown "$owner" "$WORK/qemu" || true
    fi
  fi
  ok "ISO: $ISO_PATH ($(du -h "$ISO_PATH" | cut -f1), $(stat -c %s "$ISO_PATH") bytes)"
  ok "sha256: $(cut -d' ' -f1 "$ISO_PATH.sha256")"
  stage_done iso
}

# ---------------------------------------------------------------------------------------
main() {
  stage_index "$UNTIL" >/dev/null || die "unknown stage '$UNTIL' (stages: ${STAGES[*]})"
  stage_index "$FROM" >/dev/null || die "unknown stage '$FROM' (stages: ${STAGES[*]})"
  [[ $EUID -eq 0 ]] || die "run as root: sudo $0 (or: make iso)"
  mkdir -p "$WORK" "$CACHE" "$OUT"
  exec {LOCK_FD}>"$WORK/.build.lock"
  # AURORA_BUILD_LOCK_HELD=1: the caller already holds this lock (flock work/.build.lock iso/build.sh ...).
  if [[ "${AURORA_BUILD_LOCK_HELD:-0}" != 1 ]]; then
    flock -n "$LOCK_FD" || die "another build is running (lock: $WORK/.build.lock)"
  fi
  start_log
  log "logging to $LOG_FILE"
  preflight
  if ((CLEAN)); then
    log "removing $WORK (cache kept)"
    umount_under "$WORK"
    find "$WORK" -mindepth 1 -maxdepth 1 ! -name .build.lock ! -name logs -exec rm -rf {} +
  fi
  stage_enabled base && stage_base
  stage_enabled packages && stage_packages
  stage_enabled system && stage_system
  stage_enabled squashfs && stage_squashfs
  stage_enabled iso && stage_iso
  ok "build finished in $(( $(date +%s) - BUILD_T0 ))s"
}

# Everything above is only definitions; "exit" on the same line keeps bash from reading this
# file any further, so editing build.sh while a build runs cannot affect that build.
main "$@"; exit $?
