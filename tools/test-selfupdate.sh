#!/bin/bash
# Selene OS — end-to-end test of the Selene packages and their apt repository (docs/UPDATES.md). Needs root.
#
#   tools/test-selfupdate.sh [--debs DIR] [--layer DIR]
#     --debs   aurora-{electron,shell,base}_*.deb (default: out/debs)
#     --layer  run on a read-only overlay of an image layer instead (e.g. work/layers/packages: the real Ubuntu
#              package set, real greetd / systemd-zram-generator / base-files); the layer itself is never written
#
# In a throwaway Ubuntu root (the cached debootstrap minbase tarball, unpacked under work/test-selfupdate.*; the image
# build tree is never touched):
#   1. a stand-in "greetd" package owns /etc/greetd/config.toml; the Selene debs install (dpkg -i) and divert it
#      instead of clobbering it; os-release says Selene; /opt/aurora/* and the helpers belong to the Selene packages
#   2. version N+1 of aurora-shell + aurora-base (repacked) goes into a signed repository (tools/build-repo.sh, the
#      Selene key); apt verifies it with the image's keyring and `apt-get upgrade` installs it (new os-release,
#      new /opt/aurora/shell/selene-version, the admin's conffile change kept)
#   3. a failing Selene source (missing repository, then a repository signed by another key) makes `apt-get update`
#      fail; aurora-admin's apt_update retries without it and the other source still updates (also --error-on=any)
#   4. removing aurora-base gives Ubuntu's greetd config back
set -euo pipefail
AURORA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEBS="$AURORA_ROOT/out/debs"
LAYER=""
while (($#)); do
  case "$1" in --debs) DEBS="${2:?}"; shift 2 ;; --layer) LAYER="$(readlink -f "${2:?}")"; shift 2 ;; *) echo "usage: $0 [--debs DIR] [--layer DIR]" >&2; exit 2 ;; esac
done
[[ $(id -u) == 0 ]] || { echo "test-selfupdate: needs root (chroot)" >&2; exit 77; }
[[ -z "$LAYER" || -d "$LAYER/var/lib/dpkg" ]] || { echo "test-selfupdate: $LAYER is not a root filesystem" >&2; exit 1; }
BASE_TAR="$(ls -1t "$AURORA_ROOT"/cache/base/noble-amd64-minbase-*.tar.zst 2>/dev/null | head -n1 || true)"
[[ -n "$BASE_TAR" || -n "$LAYER" ]] || { echo "test-selfupdate: no cache/base/noble-amd64-minbase-*.tar.zst (run the base stage once)" >&2; exit 77; }
for p in aurora-electron aurora-shell aurora-base; do
  compgen -G "$DEBS/${p}_*.deb" >/dev/null || { echo "test-selfupdate: no $p deb in $DEBS (make debs)" >&2; exit 1; }
done

PASS=0; FAILS=0
pass() { printf 'PASS  %s\n' "$*"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
t() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$d"; else fail "$d"; fi; }

mkdir -p "$AURORA_ROOT/work"
T="$(mktemp -d "$AURORA_ROOT/work/test-selfupdate.XXXXXX")"
R="$T/root"
cleanup() {
  local m
  for m in srv/apt srv/apt-other srv/apt-bad dev proc; do mountpoint -q "$R/$m" 2>/dev/null && umount -l "$R/$m"; done
  mountpoint -q "$R" 2>/dev/null && umount -l "$R"
  rm -rf "$T"
}
trap cleanup EXIT
mkdir -p "$R"
if [[ -n "$LAYER" ]]; then
  mkdir -p "$T/upper" "$T/wd"
  mount -t overlay overlay -o "lowerdir=$LAYER,upperdir=$T/upper,workdir=$T/wd" "$R"
else
  zstd -dc "$BASE_TAR" | tar -C "$R" -xf -
fi
mount -t proc proc "$R/proc"
mount -t tmpfs -o mode=0755 tmpfs "$R/dev"
for n in null:1:3 zero:1:5 random:1:8 urandom:1:9; do IFS=: read -r a b c <<<"$n"; mknod -m 666 "$R/dev/$a" c "$b" "$c"; done
ch() { chroot "$R" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive "$@"; }
rm -f "$R"/etc/apt/sources.list "$R"/etc/apt/sources.list.d/*   # offline: only the test's own sources

# ---- 1. install ---------------------------------------------------------------------------------------------
fake="$T/fake-greetd"
mkdir -p "$fake/DEBIAN" "$fake/etc/greetd" "$fake/usr/sbin"
printf '#!/bin/sh\n' >"$fake/usr/sbin/greetd"; chmod 755 "$fake/usr/sbin/greetd"
printf 'Package: greetd\nVersion: 0.0-fake\nArchitecture: amd64\nMaintainer: test <t@t.invalid>\nDescription: stand-in for Ubuntu greetd\n' >"$fake/DEBIAN/control"
echo '# ubuntu greetd config' >"$fake/etc/greetd/config.toml"
echo /etc/greetd/config.toml >"$fake/DEBIAN/conffiles"
dpkg-deb --root-owner-group -b "$fake" "$T/greetd.deb" >/dev/null
mkdir -p "$R/tmp/debs"
cp "$T/greetd.deb" "$DEBS"/aurora-{electron,shell,base}_*.deb "$R/tmp/debs/"
if ch dpkg-query -W greetd >/dev/null 2>&1; then
  sed -i '/^# ubuntu greetd config$/d' "$R/etc/greetd/config.toml"; echo '# ubuntu greetd config' >>"$R/etc/greetd/config.toml"
else
  ch dpkg -i /tmp/debs/greetd.deb </dev/null >/dev/null
fi
if ch /bin/sh -c 'dpkg -i /tmp/debs/aurora-electron_*.deb /tmp/debs/aurora-base_*.deb /tmp/debs/aurora-shell_*.deb' </dev/null >"$T/dpkg.log" 2>&1; then
  pass "dpkg -i aurora-electron aurora-base aurora-shell"
else
  fail "dpkg -i of the Selene packages"; cat "$T/dpkg.log"
fi
v0="$(ch dpkg-query -W -f='${Version}' aurora-shell || true)"
t "aurora-shell $v0 installed" grep -q "install ok installed" <(ch dpkg-query -W -f='${Status}' aurora-shell)
[[ "$(ch dpkg-query -S /opt/aurora/shell/main/index.js | cut -d: -f1)" == aurora-shell ]] && pass "dpkg -S: /opt/aurora/shell belongs to aurora-shell" || fail "dpkg -S /opt/aurora/shell"
[[ "$(ch dpkg-query -S /opt/aurora/electron/electron | cut -d: -f1)" == aurora-electron ]] && pass "dpkg -S: /opt/aurora/electron belongs to aurora-electron" || fail "dpkg -S /opt/aurora/electron"
[[ "$(ch dpkg-query -S /usr/lib/aurora/helpers/aurora-admin | cut -d: -f1)" == aurora-base ]] && pass "dpkg -S: aurora-admin belongs to aurora-base" || fail "dpkg -S aurora-admin"
[[ "$(stat -c '%U:%G %a' "$R/opt/aurora/electron/chrome-sandbox")" == "root:root 4755" ]] && pass "chrome-sandbox root:root 4755" || fail "chrome-sandbox mode $(stat -c '%U:%G %a' "$R/opt/aurora/electron/chrome-sandbox")"
[[ "$(stat -c '%a' "$R/etc/sudoers.d/aurora")" == 440 ]] && pass "sudoers.d/aurora is 0440" || fail "sudoers.d/aurora mode"
t "Ubuntu's greetd config kept as config.toml.ubuntu" grep -qx '# ubuntu greetd config' "$R/etc/greetd/config.toml.ubuntu"
[[ "$(readlink "$R/etc/systemd/zram-generator.conf")" == zram-generator.conf.selene ]] && pass "/etc/systemd/zram-generator.conf -> zram-generator.conf.selene" || fail "zram-generator.conf is not the Selene symlink"
t "Selene's greetd config installed" grep -q aurora "$R/etc/greetd/config.toml"
[[ "$(readlink "$R/etc/greetd/config.toml")" == config.toml.selene ]] && pass "/etc/greetd/config.toml -> config.toml.selene" || fail "greetd config is not the Selene symlink"
t "greetd still installed (nothing clobbered)" grep -q "install ok installed" <(ch dpkg-query -W -f='${Status}' greetd)
[[ "$(ch dpkg-divert --listpackage /etc/greetd/config.toml)" == aurora-base ]] && pass "greetd config diverted by aurora-base" || fail "greetd config not diverted"
t "os-release: Selene OS (ID=ubuntu kept)" grep -q '^NAME="Selene OS"' "$R/usr/lib/os-release"
t "os-release keeps ID=ubuntu" grep -qx 'ID=ubuntu' "$R/usr/lib/os-release"
t "Ubuntu's os-release kept as os-release.ubuntu" grep -q '^NAME="Ubuntu"' "$R/usr/lib/os-release.ubuntu"
t "selene.sources is a conffile of aurora-base" grep -qx /etc/apt/sources.list.d/selene.sources "$R/var/lib/dpkg/info/aurora-base.conffiles"
t "Selene keyring in /usr/share/keyrings" test -s "$R/usr/share/keyrings/selene-archive-keyring.gpg"

# ---- 2. update from the signed repository -----------------------------------------------------------------------
up="$T/up"; mkdir -p "$up/debs"
bump() { # deb -> repacked deb with the build number + 1
  local d="$1" x="$T/x" ver nver pkg
  rm -rf "$x"; dpkg-deb -R "$d" "$x"
  ver="$(sed -n 's/^Version: //p' "$x/DEBIAN/control")"; pkg="$(sed -n 's/^Package: //p' "$x/DEBIAN/control")"
  nver="${ver%-*}-$(( ${ver##*-} + 1 ))"
  sed -i "s/^Version: .*/Version: $nver/" "$x/DEBIAN/control"
  [[ -f "$x/opt/aurora/shell/selene-version" ]] && echo "$nver" >"$x/opt/aurora/shell/selene-version"
  dpkg-deb --root-owner-group -Zgzip -z1 -b "$x" "$up/debs/${pkg}_${nver}_amd64.deb" >/dev/null
  echo "$nver"
}
v1="$(bump "$(ls "$DEBS"/aurora-shell_*.deb)")"
bump "$(ls "$DEBS"/aurora-base_*.deb)" >/dev/null
cp "$DEBS"/aurora-electron_*.deb "$up/debs/"
"$AURORA_ROOT/tools/build-repo.sh" --debs "$up/debs" --out "$up/apt" >/dev/null 2>&1 && pass "tools/build-repo.sh signs a repository" || fail "build-repo.sh"
t "repository has InRelease and Release.gpg" test -s "$up/apt/dists/noble/InRelease" -a -s "$up/apt/dists/noble/Release.gpg"
mkdir -p "$R/srv/apt"; mount --bind "$up/apt" "$R/srv/apt"
# The admin edits a conffile: the change must survive the update (--force-confold, as aurora-admin apt-upgrade).
echo '# local change' >>"$R/etc/aurora/session.conf"
sed -i 's|^URIs: .*|URIs: file:/srv/apt|; s|^Enabled: no$|Enabled: yes|' "$R/etc/apt/sources.list.d/selene.sources"
if ch apt-get -q update >"$T/upd.log" 2>&1 && ! grep -q '^[WE]:' "$T/upd.log"; then pass "apt-get update: Selene repository verified with the image's keyring"
else fail "apt-get update of the Selene repository"; cat "$T/upd.log"; fi
sim="$(ch apt-get -s -q upgrade --with-new-pkgs 2>/dev/null | grep '^Inst ' || true)"
grep -Eq "^Inst aurora-shell \[$v0\] \($v1 Selene OS:[^ ]*noble \[amd64\]\)" <<<"$sim" && pass "apt-check view: Inst aurora-shell [$v0] ($v1 Selene OS:…noble)" || { fail "upgrade simulation"; echo "$sim"; }
if ch apt-get -q -y -o Dpkg::Options::=--force-confdef -o Dpkg::Use-Pty=0 -o Dpkg::Options::=--force-confold upgrade --with-new-pkgs </dev/null >"$T/up.log" 2>&1; then pass "apt-get upgrade installs the update"
else fail "apt-get upgrade"; tail -20 "$T/up.log"; fi
[[ "$(ch dpkg-query -W -f='${Version}' aurora-shell)" == "$v1" ]] && pass "aurora-shell is now $v1" || fail "aurora-shell not upgraded"
[[ "$(cat "$R/opt/aurora/shell/selene-version")" == "$v1" ]] && pass "selene-version file updated (the shell offers « Redémarrer la session »)" || fail "selene-version"
t "the admin's conffile change kept" grep -qx '# local change' "$R/etc/aurora/session.conf"
[[ "$(ch dpkg-divert --listpackage /etc/greetd/config.toml)" == aurora-base ]] && pass "diversion kept across the upgrade" || fail "diversion lost on upgrade"

# ---- 3. a failing Selene source never blocks the other sources ----------------------------------------------------
mkdir -p "$R/srv/apt-other"; mount --bind "$up/apt" "$R/srv/apt-other"
cat >"$R/etc/apt/sources.list.d/other.sources" <<'EOF'
Types: deb
URIs: file:/srv/apt-other
Suites: noble
Components: main
Signed-By: /usr/share/keyrings/selene-archive-keyring.gpg
EOF
fn="$(sed -n '/^# -* BEGIN apt_update/,/^# -* END apt_update/p' "$AURORA_ROOT/rootfs/usr/lib/aurora/helpers/aurora-admin")"
[[ -n "$fn" ]] && pass "aurora-admin has apt_update" || fail "apt_update block not found in aurora-admin"
try_update() { # label [apt options]
  local label="$1"; shift
  rm -rf "$R"/var/lib/apt/lists/*_srv_apt-other_*
  if ch apt-get -q "$@" update >"$T/plain.log" 2>&1; then
    fail "$label: plain apt-get update should fail ($(grep -m1 '^[WE]:' "$T/plain.log"))"
  else pass "$label: plain apt-get update fails"; fi
  if ch /bin/bash -c "log() { :; }; $fn
apt_update $*" >"$T/safe.log" 2>&1; then pass "$label: apt_update succeeds without the Selene source"
  else fail "$label: apt_update"; cat "$T/safe.log"; fi
  compgen -G "$R/var/lib/apt/lists/*_srv_apt-other_*Packages*" >/dev/null && pass "$label: the other source was updated" || fail "$label: other source lists missing"
}
sed -i 's|^URIs: .*|URIs: file:/srv/missing-repo|' "$R/etc/apt/sources.list.d/selene.sources"
try_update "missing Selene repository"
try_update "missing Selene repository, --error-on=any" --error-on=any
# A repository signed by another key.
bad="$T/bad"; mkdir -p "$bad/gnupg"; chmod 700 "$bad/gnupg"; cp -a "$up/apt" "$bad/apt"
GNUPGHOME="$bad/gnupg" gpg --batch --pinentry-mode loopback --passphrase '' --quick-gen-key 'Not Selene <x@x.invalid>' rsa2048 sign 1d >/dev/null 2>&1
GNUPGHOME="$bad/gnupg" gpg --batch --yes --clearsign -o "$bad/apt/dists/noble/InRelease" "$bad/apt/dists/noble/Release" 2>/dev/null
rm -f "$bad/apt/dists/noble/Release.gpg"
mkdir -p "$R/srv/apt-bad"; mount --bind "$bad/apt" "$R/srv/apt-bad"
sed -i 's|^URIs: .*|URIs: file:/srv/apt-bad|' "$R/etc/apt/sources.list.d/selene.sources"
try_update "Selene repository signed by another key"
t "the Selene source file is untouched" grep -q '^URIs: file:/srv/apt-bad' "$R/etc/apt/sources.list.d/selene.sources"

# ---- 4. removal gives Ubuntu's files back -------------------------------------------------------------------------
if ch dpkg -r aurora-shell aurora-base </dev/null >"$T/rm.log" 2>&1; then pass "dpkg -r aurora-shell aurora-base"; else fail "dpkg -r"; cat "$T/rm.log"; fi
t "Ubuntu's greetd config restored" grep -qx '# ubuntu greetd config' "$R/etc/greetd/config.toml"
[[ -z "$(ch dpkg-divert --listpackage /etc/greetd/config.toml)" ]] && pass "greetd diversion removed" || fail "greetd diversion left"
t "Ubuntu's os-release restored" grep -q '^NAME="Ubuntu"' "$R/usr/lib/os-release"

echo "== test-selfupdate: $PASS passed, $FAILS failed"
((FAILS == 0))
